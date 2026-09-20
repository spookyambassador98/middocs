import { useEffect, useRef, useState } from "react";
import Quill from "quill";
import * as Y from "yjs";
import "quill/dist/quill.snow.css";
import { api, type ApiBranch, type ApiStateParts } from "../api/client";
import { registerQuillExtensions } from "./quillSetup";
import { base64ToBytes, decryptBytes } from "./crypto";
import type { SocketIOProvider } from "./SocketIOProvider";

registerQuillExtensions();

interface MergePreview {
  targetDelta: unknown;
  branchDelta: unknown;
  mergedDelta: unknown;
  mergedStateBytes: Uint8Array;
}

async function reconstructDoc(parts: ApiStateParts, key: CryptoKey | undefined): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const decode = async (b64: string) => {
    const bytes = base64ToBytes(b64);
    return key ? decryptBytes(key, bytes) : bytes;
  };
  if (parts.baseline) {
    Y.applyUpdate(doc, await decode(parts.baseline), "branch-reconstruct");
  }
  for (const pending of parts.pending) {
    Y.applyUpdate(doc, await decode(pending), "branch-reconstruct");
  }
  doc.getText("quill");
  return doc;
}

function MiniPreview({ delta, label }: { delta: unknown; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);

  useEffect(() => {
    if (!ref.current || quillRef.current) return;
    quillRef.current = new Quill(ref.current, { readOnly: true, modules: { toolbar: false, cursors: false } });
  }, []);

  useEffect(() => {
    if (quillRef.current && delta) quillRef.current.setContents(delta as never);
  }, [delta]);

  return (
    <div className="merge-pane">
      <div className="merge-pane-label">{label}</div>
      <div className="merge-pane-quill" ref={ref} />
    </div>
  );
}

/**
 * Fork the current document into an independent branch, or merge one of
 * its existing branches back in. The merge itself is the interesting
 * part: Yjs updates are commutative and idempotent by construction, so
 * "merge two diverged replicas" reduces to decoding both full states into
 * a fresh throwaway doc and applying them in sequence — no bespoke
 * conflict-resolution logic needed, just Y.applyUpdate twice. What's
 * unusual is surfacing that as an explicit, reviewable action instead of
 * the silent auto-merge CRDTs normally do transparently.
 */
export function BranchMergeModal({
  docId,
  docTitle,
  encryptionKey,
  provider,
  onClose,
  onForked,
}: {
  docId: string;
  docTitle: string;
  encryptionKey: CryptoKey | undefined;
  provider: SocketIOProvider;
  onClose: () => void;
  onForked: (newDocId: string) => void;
}) {
  const [branches, setBranches] = useState<ApiBranch[] | null>(null);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<ApiBranch | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listBranches(docId)
      .then(({ branches: list }) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load branches");
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  async function fork() {
    setForking(true);
    setError(null);
    try {
      const { document } = await api.createBranch(docId);
      onForked(document.id);
    } catch {
      setError("Could not create the branch");
      setForking(false);
    }
  }

  async function selectBranch(branch: ApiBranch) {
    setSelected(branch);
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    try {
      const [targetParts, branchParts] = await Promise.all([api.getState(docId), api.getState(branch.id)]);
      const targetDoc = await reconstructDoc(targetParts, encryptionKey);
      const branchDoc = await reconstructDoc(branchParts, encryptionKey);
      const mergeDoc = new Y.Doc();
      Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(targetDoc), "branch-reconstruct");
      Y.applyUpdate(mergeDoc, Y.encodeStateAsUpdate(branchDoc), "branch-reconstruct");

      setPreview({
        targetDelta: targetDoc.getText("quill").toDelta(),
        branchDelta: branchDoc.getText("quill").toDelta(),
        mergedDelta: mergeDoc.getText("quill").toDelta(),
        mergedStateBytes: Y.encodeStateAsUpdate(mergeDoc),
      });
      targetDoc.destroy();
      branchDoc.destroy();
      mergeDoc.destroy();
    } catch {
      setError("Could not build the merge preview — check the access key if this document is encrypted");
    } finally {
      setPreviewLoading(false);
    }
  }

  function confirmMerge() {
    if (!preview) return;
    setMerging(true);
    try {
      // Applying an externally-computed full state directly onto our own
      // live document: Yjs integrates only the operations it doesn't
      // already have, and the resulting local "update" event flows
      // through the exact same pipeline a keystroke would (encrypt if
      // this is a zero-knowledge document, send, persist, broadcast) — no
      // separate server merge endpoint needed.
      Y.applyUpdate(provider.doc, preview.mergedStateBytes, "local-merge");
      onClose();
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer branch-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>🌿 Branches</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="branch-fork-row">
          <div>
            <strong>Fork “{docTitle}”</strong>
            <p className="branch-fork-hint">
              Creates an independent copy — edit it separately (including offline) without touching this document.
            </p>
          </div>
          <button className="btn btn-primary" style={{ width: "auto" }} onClick={fork} disabled={forking}>
            {forking ? "Creating…" : "+ Fork"}
          </button>
        </div>

        <div className="branch-list-header">Branches of this document</div>
        {branches === null ? (
          <div className="editor-loading" style={{ height: 80 }}>
            <div className="spinner" />
          </div>
        ) : branches.length === 0 ? (
          <p className="comments-empty">No branches yet — fork the document to create the first one.</p>
        ) : (
          <div className="branch-list">
            {branches.map((branch) => (
              <button
                key={branch.id}
                className={`branch-list-item ${selected?.id === branch.id ? "active" : ""}`}
                onClick={() => void selectBranch(branch)}
              >
                <span>{branch.icon}</span>
                <span className="branch-list-title">{branch.title}</span>
                <span className="branch-list-hint">Merge into this document →</span>
              </button>
            ))}
          </div>
        )}

        {previewLoading && (
          <div className="editor-loading" style={{ height: 120 }}>
            <div className="spinner" />
            Computing merge…
          </div>
        )}

        {preview && selected && !previewLoading && (
          <>
            <div className="merge-preview-grid">
              <MiniPreview delta={selected ? preview.branchDelta : null} label={`🌿 ${selected.title}`} />
              <MiniPreview delta={preview.targetDelta} label={`📄 ${docTitle} (current)`} />
              <MiniPreview delta={preview.mergedDelta} label="✨ Merge result" />
            </div>
            <div className="history-drawer-actions">
              <button className="btn btn-ghost" onClick={() => setSelected(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={confirmMerge} disabled={merging}>
                {merging ? "Merging…" : `Merge “${selected.title}” into this document`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
