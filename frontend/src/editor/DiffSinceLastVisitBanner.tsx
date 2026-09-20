import { useState } from "react";
import type { VisitDiff } from "./diffSinceLastVisit";

function relativeTime(ts: number): string {
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function DiffSinceLastVisitBanner({ visitDiff, onDismiss }: { visitDiff: VisitDiff; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="visit-diff-banner">
      <div className="visit-diff-summary">
        <span>
          📝 While you were away (since {relativeTime(visitDiff.since)}), the document changed by{" "}
          <strong>+{visitDiff.addedLines}</strong> / <strong>-{visitDiff.removedLines}</strong> lines.
        </span>
        <div className="visit-diff-actions">
          <button className="btn btn-ghost visit-diff-toggle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Hide changes" : "Show changes"}
          </button>
          <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        </div>
      </div>
      {expanded && (
        <pre className="visit-diff-body">
          {visitDiff.diff.map((line, i) => (
            <div key={i} className={`visit-diff-line visit-diff-${line.type}`}>
              <span className="visit-diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
              {line.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
