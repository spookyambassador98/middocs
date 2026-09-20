import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiDocument } from "../api/client";
import { getCachedDocumentKey } from "../editor/keyStore";

const ICON_CHOICES = [
  "📄", "📝", "📘", "📕", "📓", "🗒️",
  "📊", "📈", "💡", "🎯", "🚀", "✅",
  "⭐", "🔥", "🎨", "🧩", "📌", "🔖",
  "🗂️", "📎", "💬", "🧠", "🛠️", "🎉",
];

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export function DocumentCard({
  document,
  index,
  onRename,
  onDelete,
  onIconChange,
}: {
  document: ApiDocument;
  index: number;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onIconChange: (id: string, icon: string) => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(document.title);
  }, [document.title]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 2500);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  function commitRename() {
    setRenaming(false);
    const trimmed = title.trim();
    if (trimmed && trimmed !== document.title) {
      onRename(document.id, trimmed);
    } else {
      setTitle(document.title);
    }
  }

  function openDocument() {
    if (renaming) return;
    // Zero-knowledge documents need their key in the URL fragment to
    // decrypt anything; a browser that created or previously opened this
    // document has it cached locally (never on the server), so a plain
    // click on the card "just works" the same way opening a bookmarked
    // link would.
    const suffix = document.encrypted ? (() => {
      const cached = getCachedDocumentKey(document.id);
      return cached ? `#key=${cached}` : "";
    })() : "";
    navigate(`/doc/${document.id}${suffix}`);
  }

  return (
    <div
      className={`doc-card ${pickerOpen ? "picker-open" : ""}`}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      onClick={openDocument}
    >
      {(document.encrypted || document.forkedFromDocumentId) && (
        <div className="doc-badges" onClick={(e) => e.stopPropagation()}>
          {document.encrypted && (
            <span className="doc-badge lock" title="Zero-knowledge: the server never sees the contents">
              🔒
            </span>
          )}
          {document.forkedFromDocumentId && (
            <span className="doc-badge branch" title="This is a branch of another document">
              🌿
            </span>
          )}
        </div>
      )}

      <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Change icon" onClick={() => setPickerOpen((o) => !o)}>
          {document.icon}
        </button>
        <button className="icon-btn" title="Rename" onClick={() => setRenaming(true)}>
          ✎
        </button>
        {document.isOwner && (
          <button
            className={`icon-btn danger`}
            title={confirmingDelete ? "Delete for sure?" : "Delete"}
            style={confirmingDelete ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}
            onClick={() => (confirmingDelete ? onDelete(document.id) : setConfirmingDelete(true))}
          >
            {confirmingDelete ? "✓" : "🗑"}
          </button>
        )}
      </div>

      {pickerOpen && (
        <div className="icon-picker" onClick={(e) => e.stopPropagation()}>
          {ICON_CHOICES.map((icon) => (
            <button
              key={icon}
              className="icon-picker-item"
              onClick={() => {
                onIconChange(document.id, icon);
                setPickerOpen(false);
              }}
            >
              {icon}
            </button>
          ))}
        </div>
      )}

      <div className="doc-icon">{document.icon}</div>

      {renaming ? (
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setTitle(document.title);
              setRenaming(false);
            }
          }}
          style={{
            width: "100%",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            padding: "4px 6px",
            fontWeight: 700,
            marginBottom: 6,
            background: "var(--bg-alt)",
            color: "var(--text)",
          }}
        />
      ) : (
        <h3>{document.title}</h3>
      )}

      <div className="doc-meta">
        {document.isOwner ? "You" : document.ownerName} · {formatRelativeTime(document.updatedAt)}
      </div>
    </div>
  );
}
