import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api, type ApiDocument } from "../api/client";
import { Avatar } from "../components/Avatar";
import { CommandPalette, useCommandPalette, type Command } from "../components/CommandPalette";
import { BranchMergeModal } from "./BranchMergeModal";
import { CommentsPanel } from "./CommentsPanel";
import { DiffSinceLastVisitBanner } from "./DiffSinceLastVisitBanner";
import { checkForChangesSinceLastVisit, saveVisitSnapshot, type VisitDiff } from "./diffSinceLastVisit";
import { importDocumentKey } from "./crypto";
import { cacheDocumentKey, getCachedDocumentKey } from "./keyStore";
import { Editor, type EditorApi } from "./Editor";
import { HistoryDrawer } from "./HistoryDrawer";
import { PresenceStack, TypingStrip } from "./PresenceBar";
import { SocketIOProvider, type ConnectionStatus } from "./SocketIOProvider";
import { TimelapseDrawer } from "./TimelapseDrawer";
import { useAwarenessStates } from "./useAwarenessStates";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  connected: "Online",
  disconnected: "Offline",
};

const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👏", "🔥", "😮", "🤔"];

type KeyResolution = "pending" | "none" | "resolved" | "missing";

function readKeyFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("key");
}

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [docMeta, setDocMeta] = useState<ApiDocument | null>(null);
  const [keyResolution, setKeyResolution] = useState<KeyResolution>("pending");
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | undefined>(undefined);
  const [keyStr, setKeyStr] = useState<string | null>(null);
  const [manualKeyInput, setManualKeyInput] = useState("");
  const [manualKeyError, setManualKeyError] = useState<string | null>(null);

  const [provider, setProvider] = useState<SocketIOProvider | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [editorApi, setEditorApi] = useState<EditorApi | null>(null);
  const [showComments, setShowComments] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [timelapseOpen, setTimelapseOpen] = useState(false);
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false);
  const [visitDiff, setVisitDiff] = useState<VisitDiff | null>(null);
  const palette = useCommandPalette();

  // Step 1: figure out, before ever opening a socket, whether this
  // document needs a decryption key and whether we have one — from the
  // URL fragment (never sent to any server), this browser's local cache
  // of keys it has seen before, or (below) a manually pasted one.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setKeyResolution("pending");
    setDocMeta(null);
    setManualKeyError(null);

    (async () => {
      try {
        const { document } = await api.getDocument(id);
        if (cancelled) return;
        setDocMeta(document);
        if (!document.encrypted) {
          setKeyResolution("none");
          return;
        }
        const hashKey = readKeyFromHash();
        const resolved = hashKey ?? getCachedDocumentKey(id);
        if (!resolved) {
          setKeyResolution("missing");
          return;
        }
        if (hashKey) cacheDocumentKey(id, hashKey);
        const key = await importDocumentKey(resolved);
        if (cancelled) return;
        setEncryptionKey(key);
        setKeyStr(resolved);
        setKeyResolution("resolved");
      } catch {
        if (!cancelled) setFatalError("Could not load the document");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  async function submitManualKey() {
    if (!id || !manualKeyInput.trim()) return;
    try {
      const key = await importDocumentKey(manualKeyInput.trim());
      cacheDocumentKey(id, manualKeyInput.trim());
      setEncryptionKey(key);
      setKeyStr(manualKeyInput.trim());
      setKeyResolution("resolved");
    } catch {
      setManualKeyError("Could not read the key — make sure it was copied in full");
    }
  }

  // Step 2: only once key resolution has settled (nothing to wait for, or
  // we actually have a key) do we open the realtime connection. Own its
  // full lifecycle inside this one effect: create it, wire listeners, and
  // always tear it down on cleanup — including React StrictMode's
  // dev-only double mount/cleanup — so we never leak a socket connection.
  useEffect(() => {
    if (!id || !token || !user) return;
    if (keyResolution === "pending" || keyResolution === "missing") return;

    setReady(false);
    setStatus("connecting");
    setFatalError(null);
    setEditorApi(null);
    setVisitDiff(null);

    const p = new SocketIOProvider(id, token, { name: user.name, color: user.color }, encryptionKey);
    setProvider(p);

    const metaMap = p.doc.getMap<string>("meta");
    const onMetaChange = () => {
      const next = metaMap.get("title");
      if (typeof next === "string") setTitle(next);
    };
    metaMap.observe(onMetaChange);

    const offStatus = p.onStatusChange(setStatus);
    const offError = p.onError(setFatalError);
    const offReady = p.onReady(({ title: initialTitle }) => {
      // First client to ever connect seeds the shared title from
      // Postgres; afterwards the Yjs map is the live source of truth for
      // everyone already in the room, so title edits show up instantly.
      if (!metaMap.has("title")) {
        metaMap.set("title", initialTitle);
      }
      setTitle(metaMap.get("title") ?? initialTitle);
      setReady(true);

      const diff = checkForChangesSinceLastVisit(id, p.doc);
      if (diff) setVisitDiff(diff);
    });

    return () => {
      offStatus();
      offError();
      offReady();
      metaMap.unobserve(onMetaChange);
      saveVisitSnapshot(id, p.doc);
      p.destroy();
      setProvider(null);
    };
  }, [id, token, user, keyResolution, encryptionKey]);

  const localClientId = provider?.doc.clientID ?? null;
  const peers = useAwarenessStates(provider?.awareness ?? null, localClientId);

  const handleTitleChange = useCallback(
    (value: string) => {
      setTitle(value);
      if (!provider || !id) return;
      provider.doc.getMap<string>("meta").set("title", value);

      if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
      titleSaveTimer.current = setTimeout(() => {
        const trimmed = value.trim();
        if (trimmed) api.renameDocument(id, trimmed).catch(() => void 0);
      }, 600);
    },
    [provider, id]
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      provider?.sendReaction(emoji);
      setReactionMenuOpen(false);
    },
    [provider]
  );

  const insertDivider = useCallback(() => {
    if (!editorApi) return;
    const { quill } = editorApi;
    const range = quill.getSelection(true);
    const index = range ? range.index : quill.getLength();
    quill.insertText(index, "\n", "user");
    quill.insertEmbed(index + 1, "divider", true, "user");
    quill.insertText(index + 2, "\n", "user");
    quill.setSelection(index + 3, 0, "user");
  }, [editorApi]);

  const handleForked = useCallback(
    (newDocId: string) => {
      setBranchModalOpen(false);
      const suffix = keyStr ? `#key=${keyStr}` : "";
      navigate(`/doc/${newDocId}${suffix}`);
    },
    [navigate, keyStr]
  );

  const paletteCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "home", label: "Back to documents", icon: "←", run: () => navigate("/") },
      { id: "history", label: "Version history", icon: "🕐", run: () => setHistoryOpen(true) },
      { id: "timelapse", label: "Writing timelapse", icon: "🎬", run: () => setTimelapseOpen(true) },
      { id: "branches", label: "Branches and merge", icon: "🌿", run: () => setBranchModalOpen(true) },
      {
        id: "comments",
        label: showComments ? "Hide comments" : "Show comments",
        icon: "💬",
        run: () => setShowComments((s) => !s),
      },
      {
        id: "copy-link",
        label: "Copy document link",
        icon: "🔗",
        run: () => {
          void navigator.clipboard?.writeText(window.location.href);
        },
      },
    ];
    if (editorApi) {
      cmds.push(
        { id: "undo", label: "Undo", hint: "Ctrl+Z", icon: "↶", run: () => editorApi.undo() },
        { id: "redo", label: "Redo", hint: "Ctrl+Shift+Z", icon: "↷", run: () => editorApi.redo() },
        { id: "divider", label: "Insert divider", icon: "—", run: insertDivider }
      );
    }
    if (provider) {
      for (const emoji of REACTION_EMOJIS) {
        cmds.push({
          id: `react-${emoji}`,
          label: `Send reaction ${emoji}`,
          icon: emoji,
          run: () => sendReaction(emoji),
        });
      }
    }
    return cmds;
  }, [navigate, showComments, editorApi, provider, insertDivider, sendReaction]);

  if (!id) return null;

  if (fatalError) {
    return (
      <div className="editor-loading">
        <div>
          <p style={{ marginBottom: 12 }}>{fatalError}</p>
          <button className="btn btn-ghost" onClick={() => navigate("/")}>
            Back to documents
          </button>
        </div>
      </div>
    );
  }

  if (keyResolution === "missing") {
    return (
      <div className="editor-loading">
        <div className="key-prompt">
          <div style={{ fontSize: "2rem", marginBottom: 8 }}>🔒</div>
          <h3 style={{ margin: "0 0 8px" }}>This document is encrypted</h3>
          <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>
            This browser does not have the access key. Open the document from the full link (the part after
            “#key=”) or paste the key here.
          </p>
          <input
            className="editor-title-input"
            style={{ border: "1px solid var(--border)", width: "100%", marginBottom: 10 }}
            placeholder="Access key"
            value={manualKeyInput}
            onChange={(e) => setManualKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitManualKey()}
          />
          {manualKeyError && <div className="form-error">{manualKeyError}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn btn-ghost" onClick={() => navigate("/")}>
              Documents
            </button>
            <button className="btn btn-primary" style={{ width: "auto" }} onClick={submitManualKey}>
              Open
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      <div className="editor-topbar">
        <button className="icon-btn" onClick={() => navigate("/")} title="Back to documents">
          ←
        </button>
        {provider?.encrypted && (
          <span className="lock-pill" title="Zero-knowledge: the server never sees the contents">
            🔒
          </span>
        )}
        <input
          className="editor-title-input"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Untitled"
        />
        <div className="editor-topbar-spacer" />

        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!editorApi} onClick={() => editorApi?.undo()}>
          ↶
        </button>
        <button
          className="icon-btn"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!editorApi}
          onClick={() => editorApi?.redo()}
        >
          ↷
        </button>
        <button className="icon-btn" title="Version history" onClick={() => setHistoryOpen(true)}>
          🕐
        </button>
        <button className="icon-btn" title="Writing timelapse" onClick={() => setTimelapseOpen(true)}>
          🎬
        </button>
        <button className="icon-btn" title="Branches and merge" onClick={() => setBranchModalOpen(true)}>
          🌿
        </button>
        <button
          className={`icon-btn ${showComments ? "active" : ""}`}
          title="Comments"
          onClick={() => setShowComments((s) => !s)}
        >
          💬
        </button>
        <div className="reaction-trigger-wrap">
          <button className="icon-btn" title="Send a reaction" onClick={() => setReactionMenuOpen((o) => !o)}>
            🙂
          </button>
          {reactionMenuOpen && (
            <div className="reaction-picker" onMouseLeave={() => setReactionMenuOpen(false)}>
              {REACTION_EMOJIS.map((emoji) => (
                <button key={emoji} className="reaction-picker-item" onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn" title="Command palette (Ctrl+K)" onClick={() => palette.setOpen(true)}>
          ⌘
        </button>

        <PresenceStack peers={peers} />
        <span className={`connection-pill ${status}`}>
          <span className="connection-dot" />
          {STATUS_LABEL[status]}
        </span>
        {user && <Avatar name={user.name} color={user.color} size={30} />}
      </div>

      <TypingStrip peers={peers} />

      {visitDiff && <DiffSinceLastVisitBanner visitDiff={visitDiff} onDismiss={() => setVisitDiff(null)} />}

      <div className="editor-scroll">
        {!ready || !provider ? (
          <div className="editor-loading">
            <div className="spinner" />
            Loading document…
          </div>
        ) : (
          <div className="editor-body">
            {/* Keyed by doc id so navigating straight from one document to
                another (without unmounting EditorPage) forces a fresh Quill
                instance on a fresh DOM node, instead of re-initializing Quill
                on top of its own previous markup. */}
            <Editor key={id} provider={provider} onReady={setEditorApi} />
            {showComments && editorApi && user && (
              <CommentsPanel quill={editorApi.quill} doc={provider.doc} me={user} />
            )}
          </div>
        )}
      </div>

      {historyOpen && (
        <HistoryDrawer
          docId={id}
          encryptionKey={encryptionKey}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => setHistoryOpen(false)}
        />
      )}

      {timelapseOpen && (
        <TimelapseDrawer
          docId={id}
          docTitle={title || docMeta?.title || "Document"}
          encryptionKey={encryptionKey}
          onClose={() => setTimelapseOpen(false)}
        />
      )}

      {branchModalOpen && provider && (
        <BranchMergeModal
          docId={id}
          docTitle={title || docMeta?.title || "Document"}
          encryptionKey={encryptionKey}
          provider={provider}
          onClose={() => setBranchModalOpen(false)}
          onForked={handleForked}
        />
      )}

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} commands={paletteCommands} />
    </div>
  );
}
