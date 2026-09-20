import { useEffect, useRef, useState } from "react";
import Quill from "quill";
import * as Y from "yjs";
import "quill/dist/quill.snow.css";
import { api } from "../api/client";
import { registerQuillExtensions } from "./quillSetup";
import { decryptBytes } from "./crypto";
import { deltaToHtml, type DeltaOp } from "./deltaHtml";
import { buildTimelapseExportHtml } from "./timelapseExport";

registerQuillExtensions();

const MAX_EXPORT_FRAMES = 200;

interface Step {
  t: number; // ms since the first recorded operation
  delta: DeltaOp[];
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Operation-level "timelapse": replays a document's *entire* recorded
 * update log (see document_updates in schema.sql) one operation at a time,
 * rather than jumping between HistoryDrawer's periodic checkpoints — close
 * to watching the document actually being typed. Also exports a
 * downsampled, fully self-contained HTML file of the same replay (see
 * timelapseExport.ts) that works standalone, with no server and no app.
 */
export function TimelapseDrawer({
  docId,
  docTitle,
  encryptionKey,
  onClose,
}: {
  docId: string;
  docTitle: string;
  encryptionKey?: CryptoKey;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [exporting, setExporting] = useState(false);

  const previewRef = useRef<HTMLDivElement>(null);
  const previewQuillRef = useRef<Quill | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!previewRef.current || previewQuillRef.current) return;
    previewQuillRef.current = new Quill(previewRef.current, {
      readOnly: true,
      modules: { toolbar: false, cursors: false },
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ ops }, { updates }] = await Promise.all([api.listTimelapse(docId), api.getTimelapseUpdates(docId)]);
        if (cancelled) return;
        if (ops.length === 0 || updates.length === 0) {
          setSteps([]);
          setLoading(false);
          return;
        }
        const startMs = new Date(ops[0].createdAt).getTime();
        const scratch = new Y.Doc();
        const text = scratch.getText("quill");
        const built: Step[] = [];
        const count = Math.min(ops.length, updates.length);
        for (let i = 0; i < count; i++) {
          let bytes = base64ToBytes(updates[i]);
          if (encryptionKey) {
            try {
              bytes = await decryptBytes(encryptionKey, bytes);
            } catch {
              // A stray update this key can't decrypt shouldn't sink the
              // whole replay — skip it and keep going.
              continue;
            }
          }
          Y.applyUpdate(scratch, bytes, "timelapse-replay");
          const t = new Date(ops[i].createdAt).getTime() - startMs;
          built.push({ t: Math.max(0, t), delta: text.toDelta() as DeltaOp[] });
        }
        scratch.destroy();
        if (!cancelled) {
          setSteps(built);
          setIndex(built.length - 1);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load the timelapse");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, encryptionKey]);

  useEffect(() => {
    if (!steps || !previewQuillRef.current) return;
    const step = steps[index];
    if (step) previewQuillRef.current.setContents(step.delta as never);
  }, [steps, index]);

  useEffect(() => {
    if (!playing || !steps || steps.length < 2) return;
    playTimerRef.current = setInterval(() => {
      setIndex((i) => {
        if (i >= steps.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 90 / speed);
    return () => {
      if (playTimerRef.current) clearInterval(playTimerRef.current);
    };
  }, [playing, speed, steps]);

  function exportHtml() {
    if (!steps || steps.length === 0) return;
    setExporting(true);
    try {
      const frameCount = Math.min(steps.length, MAX_EXPORT_FRAMES);
      const frames = Array.from({ length: frameCount }, (_, i) => {
        const stepIndex = frameCount === 1 ? steps.length - 1 : Math.round((i * (steps.length - 1)) / (frameCount - 1));
        const step = steps[stepIndex];
        return { t: step.t, html: deltaToHtml(step.delta) };
      });
      const html = buildTimelapseExportHtml(docTitle || "Document", frames);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = (docTitle || "document").replace(/[^\p{L}\p{N}\-_]+/gu, "_").slice(0, 60) || "document";
      a.download = `${safeName}-timelapse.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  const current = steps?.[index];

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer timelapse-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>🎬 Writing timelapse</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {loading ? (
          <div className="editor-loading" style={{ height: 200 }}>
            <div className="spinner" />
          </div>
        ) : !steps || steps.length === 0 ? (
          <p className="comments-empty">No recorded edits yet for a timelapse.</p>
        ) : (
          <>
            <div className="history-preview-frame">
              <div ref={previewRef} className="history-preview-quill" />
            </div>

            <div className="history-timeline">
              <input
                type="range"
                min={0}
                max={steps.length - 1}
                value={index}
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
              />
              <div className="history-timeline-label">
                <span>
                  Step {index + 1} of {steps.length} · {formatClock(current?.t ?? 0)}
                </span>
                <select
                  className="timelapse-speed"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                  <option value={8}>8×</option>
                </select>
              </div>
            </div>

            <div className="history-drawer-actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (index >= steps.length - 1) setIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={exportHtml} disabled={exporting}>
                {exporting ? "Exporting…" : "⬇ Export as HTML"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
