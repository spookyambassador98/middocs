import { useEffect, useState } from "react";
import type Quill from "quill";
import * as Y from "yjs";
import type { ApiUser } from "../api/client";
import { Avatar } from "../components/Avatar";

type Comment = {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  body: string;
  quote: string;
  createdAt: number;
  resolved: boolean;
};

function readComments(doc: Y.Doc): Comment[] {
  const arr = doc.getArray<Comment>("comments");
  return arr.toArray().slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function CommentsPanel({
  quill,
  doc,
  me,
}: {
  quill: Quill;
  doc: Y.Doc;
  me: ApiUser;
}) {
  const [comments, setComments] = useState<Comment[]>(() => readComments(doc));
  const [draft, setDraft] = useState("");
  const [composer, setComposer] = useState<{ top: number; left: number; quote: string } | null>(null);

  useEffect(() => {
    const arr = doc.getArray<Comment>("comments");
    const sync = () => setComments(readComments(doc));
    arr.observe(sync);
    return () => arr.unobserve(sync);
  }, [doc]);

  useEffect(() => {
    const onSelect = (range: { index: number; length: number } | null) => {
      if (!range || range.length === 0) {
        setComposer(null);
        return;
      }
      const bounds = quill.getBounds(range.index, range.length);
      if (!bounds) return;
      const quote = quill.getText(range.index, range.length).trim().slice(0, 180);
      if (!quote) return;
      const root = quill.root.getBoundingClientRect();
      setComposer({
        top: root.top + bounds.bottom + 8,
        left: Math.min(window.innerWidth - 280, root.left + bounds.left),
        quote,
      });
    };
    quill.on("selection-change", onSelect);
    return () => {
      quill.off("selection-change", onSelect);
    };
  }, [quill]);

  function addComment() {
    const body = draft.trim();
    if (!body || !composer) return;
    const comment: Comment = {
      id: crypto.randomUUID(),
      authorId: me.id,
      authorName: me.name,
      authorColor: me.color,
      body,
      quote: composer.quote,
      createdAt: Date.now(),
      resolved: false,
    };
    doc.getArray<Comment>("comments").insert(0, [comment]);
    setDraft("");
    setComposer(null);
  }

  function patch(id: string, next: Partial<Comment>) {
    const arr = doc.getArray<Comment>("comments");
    const list = arr.toArray();
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) return;
    arr.delete(index, 1);
    arr.insert(index, [{ ...list[index], ...next }]);
  }

  function remove(id: string) {
    const arr = doc.getArray<Comment>("comments");
    const index = arr.toArray().findIndex((c) => c.id === id);
    if (index < 0) return;
    arr.delete(index, 1);
  }

  const openCount = comments.filter((c) => !c.resolved).length;

  return (
    <>
      <aside className="comments-panel">
        <div className="comments-panel-header">
          Comments
          <span className="comments-count">{openCount}</span>
        </div>
        {comments.length === 0 ? (
          <p className="comments-empty">Select text in the doc to leave a comment.</p>
        ) : (
          <div className="comments-list">
            {comments.map((comment) => (
              <article key={comment.id} className={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                <div className="comment-card-head">
                  <Avatar name={comment.authorName} color={comment.authorColor} size={22} />
                  <span className="comment-author">{comment.authorName}</span>
                  <span className="comment-time">
                    {new Date(comment.createdAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {comment.quote ? <div className="comment-quote">{comment.quote}</div> : null}
                <div className="comment-text">{comment.body}</div>
                <div className="comment-actions">
                  <button className="comment-action" onClick={() => patch(comment.id, { resolved: !comment.resolved })}>
                    {comment.resolved ? "Reopen" : "Resolve"}
                  </button>
                  {comment.authorId === me.id ? (
                    <button className="comment-action danger" onClick={() => remove(comment.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </aside>

      {composer ? (
        <div className="comment-composer" style={{ top: composer.top, left: composer.left }}>
          <div className="comment-quote">{composer.quote}</div>
          <textarea
            autoFocus
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addComment();
            }}
          />
          <div className="comment-composer-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setComposer(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" style={{ width: "auto" }} onClick={addComment}>
              Comment
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
