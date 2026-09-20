import { useEffect, useRef, useState } from "react";
import Quill from "quill";
import * as Y from "yjs";
import "quill/dist/quill.snow.css";
import { api, type ApiSnapshot } from "../api/client";
import { registerQuillExtensions } from "./quillSetup";
import { decryptBytes } from "./crypto";

registerQuillExtensions();

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function HistoryDrawer({
  docId,
  encryptionKey,
  onClose,
  onRestored,
}: {
  docId: string;
  encryptionKey?: CryptoKey;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [snapshots, setSnapshots] = useState<ApiSnapshot[] | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);

  useEffect(() => {
    if (!previewRef.current || quillRef.current) return;
    quillRef.current = new Quill(previewRef.current, {
      readOnly: true,
      modules: { toolbar: false, cursors: false },
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listHistory(docId)
      .then(({ snapshots: list }) => {
        if (cancelled) return;
        setSnapshots(list);
        setIndex(Math.max(0, list.length - 1));
      })
      .catch(() => {
        if (!cancelled) setError("Could not load version history");
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const current = snapshots?.[index] ?? null;

  useEffect(() => {
    if (!current || !quillRef.current) return;
    let cancelled = false;
    setLoadingPreview(true);
    api
      .getHistorySnapshot(docId, current.id)
      .then(async ({ state }) => {
        let bytes = base64ToBytes(state);
        if (encryptionKey) bytes = await decryptBytes(encryptionKey, bytes);
        if (cancelled) return;
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, bytes);
        const delta = new Y.Text();
        // y-quill stores ops on Y.Text named "quill"
        const text = ydoc.getText("quill");
        quillRef.current?.setText(text.toString());
        ydoc.destroy();
        void delta;
      })
      .catch(() => {
        if (!cancelled) setError("Could not preview this version");
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [current, docId, encryptionKey]);

  async function restore() {
    if (!current) return;
    setRestoring(true);
    try {
      await api.restoreHistorySnapshot(docId, current.id);
      onRestored();
    } catch {
      setError("Could not restore this version");
    } finally {
      setRestoring(false);
    }
  }

  const isLatest = snapshots != null && index === snapshots.length - 1;

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>Version history</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        {snapshots === null ? (
          <div className="editor-loading" style={{ height: 200 }}>
            <div className="spinner" />
          </div>
        ) : snapshots.length === 0 ? (
          <p className="comments-empty">No checkpoints yet — keep writing and history will appear.</p>
        ) : (
          <>
            <div className="history-preview-frame">
              <div ref={previewRef} className="history-preview-quill" />
              {loadingPreview ? (
                <div className="history-preview-loading">
                  <div className="spinner" />
                </div>
              ) : null}
            </div>
            <div className="history-timeline">
              <input
                type="range"
                min={0}
                max={snapshots.length - 1}
                value={index}
                onChange={(e) => setIndex(Number(e.target.value))}
              />
              <div className="history-timeline-label">
                <span>
                  {new Date(current?.createdAt ?? Date.now()).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {isLatest ? <span className="history-current-badge">Latest</span> : null}
              </div>
            </div>
            <div className="history-drawer-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                Close
              </button>
              <button
                className="btn btn-primary"
                style={{ width: "auto" }}
                onClick={() => void restore()}
                disabled={restoring || isLatest || Boolean(encryptionKey)}
                title={encryptionKey ? "Encrypted docs restore from the live editor, not this server checkpoint." : undefined}
              >
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
