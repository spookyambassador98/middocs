import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ApiDocument } from "../api/client";

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ч назад`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "вчера";
  if (diffDay < 7) return `${diffDay} дн назад`;
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function DocumentCard({
  document,
  index,
  onRename,
  onDelete,
}: {
  document: ApiDocument;
  index: number;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  return (
    <div
      className="doc-card"
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      onClick={() => !renaming && navigate(`/doc/${document.id}`)}
    >
      <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Переименовать" onClick={() => setRenaming(true)}>
          ✎
        </button>
        {document.isOwner && (
          <button
            className={`icon-btn danger`}
            title={confirmingDelete ? "Точно удалить?" : "Удалить"}
            style={confirmingDelete ? { background: "var(--danger-soft)", color: "var(--danger)" } : undefined}
            onClick={() => (confirmingDelete ? onDelete(document.id) : setConfirmingDelete(true))}
          >
            {confirmingDelete ? "✓" : "🗑"}
          </button>
        )}
      </div>

      <div className="doc-icon">Aa</div>

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
        {document.isOwner ? "Вы" : document.ownerName} · {formatRelativeTime(document.updatedAt)}
      </div>
    </div>
  );
}
