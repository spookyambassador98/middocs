import { useEffect, useMemo, useState } from "react";
import { api, type ApiActivity, type ApiActivityDay } from "../api/client";

const HEATMAP_WEEKS = 26;

interface HeatmapDay {
  date: string;
  ops: number;
}

/** Builds a Monday-aligned grid of weeks × 7 days covering the last `weeks` weeks, filling in zero-op days that the sparse `daily` array never mentions. */
function buildHeatmapWeeks(daily: ApiActivityDay[], weeks: number): HeatmapDay[][] {
  const map = new Map(daily.map((d) => [d.date, d.ops]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dow = today.getUTCDay(); // 0 = Sunday
  const diffToMonday = (dow + 6) % 7;
  const gridStart = new Date(today);
  gridStart.setUTCDate(today.getUTCDate() - diffToMonday - (weeks - 1) * 7);

  const weeksArr: HeatmapDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatmapDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart);
      date.setUTCDate(gridStart.getUTCDate() + w * 7 + d);
      const key = date.toISOString().slice(0, 10);
      col.push({ date: key, ops: map.get(key) ?? 0 });
    }
    weeksArr.push(col);
  }
  return weeksArr;
}

function intensityClass(ops: number, max: number): string {
  if (ops === 0) return "l0";
  const ratio = ops / Math.max(max, 1);
  if (ratio > 0.75) return "l4";
  if (ratio > 0.5) return "l3";
  if (ratio > 0.25) return "l2";
  return "l1";
}

function computeStreaks(daily: ApiActivityDay[]): { current: number; longest: number } {
  const activeDays = new Set(daily.filter((d) => d.ops > 0).map((d) => d.date));
  const sorted = Array.from(activeDays).sort();

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const dateStr of sorted) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  let current = 0;
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  // If today has no activity yet (the session might just be in progress,
  // or it's early), a streak still "counts" through yesterday.
  if (!activeDays.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (activeDays.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { current, longest };
}

function formatSessionTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(startIso: string, endIso: string): string {
  const minutes = Math.max(1, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/**
 * "Flow" — a personal writing-activity dashboard built ENTIRELY from
 * operation timestamps and counts (see backend service.ts's
 * getUserActivity, fed by document_updates.author_id — added for the
 * notary feature and reused here for free). Deliberately never touches
 * the actual text of any document, so it works identically, and with the
 * same privacy boundary, whether the activity came from an encrypted
 * document or a plaintext one.
 */
export function FlowDashboard({ onClose }: { onClose: () => void }) {
  const [activity, setActivity] = useState<ApiActivity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getActivity(HEATMAP_WEEKS * 7)
      .then((data) => {
        if (!cancelled) setActivity(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load activity");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const daily = activity?.daily ?? [];
  const weeks = useMemo(() => buildHeatmapWeeks(daily, HEATMAP_WEEKS), [daily]);
  const maxOps = useMemo(() => daily.reduce((m, d) => Math.max(m, d.ops), 1), [daily]);
  const totalOps = useMemo(() => daily.reduce((sum, d) => sum + d.ops, 0), [daily]);
  const streaks = useMemo(() => computeStreaks(daily), [daily]);
  const mostActive = useMemo(
    () => daily.reduce<ApiActivityDay | null>((best, d) => (!best || d.ops > best.ops ? d : best), null),
    [daily]
  );

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer flow-dashboard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>Flow — your writing activity</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {!activity ? (
          <div className="editor-loading" style={{ height: 200 }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            <div className="flow-stats">
              <div className="flow-stat">
                <div className="flow-stat-value">{totalOps.toLocaleString("ru-RU")}</div>
                <div className="flow-stat-label">edits over {HEATMAP_WEEKS} weeks</div>
              </div>
              <div className="flow-stat">
                <div className="flow-stat-value">{streaks.current}</div>
                <div className="flow-stat-label">days in a row now</div>
              </div>
              <div className="flow-stat">
                <div className="flow-stat-value">{streaks.longest}</div>
                <div className="flow-stat-label">best streak</div>
              </div>
              <div className="flow-stat">
                <div className="flow-stat-value">{mostActive && mostActive.ops > 0 ? mostActive.ops : "—"}</div>
                <div className="flow-stat-label">
                  {mostActive && mostActive.ops > 0
                    ? `record: ${new Date(mostActive.date).toLocaleDateString("en-US", { day: "2-digit", month: "short" })}`
                    : "most active day"}
                </div>
              </div>
            </div>

            <div className="flow-heatmap-wrap">
              <div className="flow-heatmap-weekdays">
                {WEEKDAY_LABELS.map((label, i) => (
                  <span key={i}>{label}</span>
                ))}
              </div>
              <div className="flow-heatmap">
                {weeks.map((col, wi) => (
                  <div className="flow-heatmap-col" key={wi}>
                    {col.map((day) => (
                      <div
                        key={day.date}
                        className={`flow-heatmap-cell ${intensityClass(day.ops, maxOps)}`}
                        title={`${day.date}: ${day.ops} edits`}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="flow-sessions">
              <div className="branch-list-header">Recent writing sessions</div>
              {activity.sessions.length === 0 ? (
                <p className="comments-empty">No recorded activity yet.</p>
              ) : (
                <div className="flow-session-list">
                  {activity.sessions.slice(0, 20).map((s, i) => (
                    <div className="flow-session-row" key={i}>
                      <span className="flow-session-time">{formatSessionTime(s.start)}</span>
                      <span className="flow-session-duration">{formatDuration(s.start, s.end)}</span>
                      <span className="flow-session-ops">{s.opCount} edits</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
