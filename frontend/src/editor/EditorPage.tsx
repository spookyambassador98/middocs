import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { Avatar } from "../components/Avatar";
import { ShareLiveProjectButton } from "../components/ShareLiveProjectButton";
import { Editor } from "./Editor";
import { PresenceStack, TypingStrip } from "./PresenceBar";
import { SocketIOProvider, type ConnectionStatus } from "./SocketIOProvider";
import { useAwarenessStates } from "./useAwarenessStates";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Подключение…",
  connected: "В сети",
  disconnected: "Нет соединения",
};

export default function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [provider, setProvider] = useState<SocketIOProvider | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Own the provider's full lifecycle inside a single effect: create it,
  // wire listeners, and always tear it down on cleanup. This runs exactly
  // once per (id, token, user) change — including React StrictMode's
  // dev-only double mount/cleanup — so we never leak a socket connection.
  useEffect(() => {
    if (!id || !token || !user) return;

    setReady(false);
    setStatus("connecting");
    setFatalError(null);

    const p = new SocketIOProvider(id, token, { name: user.name, color: user.color });
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
    });

    return () => {
      offStatus();
      offError();
      offReady();
      metaMap.unobserve(onMetaChange);
      p.destroy();
      setProvider(null);
    };
  }, [id, token, user]);

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

  if (!id) return null;

  if (fatalError) {
    return (
      <div className="editor-loading">
        <div>
          <p style={{ marginBottom: 12 }}>{fatalError}</p>
          <button className="btn btn-ghost" onClick={() => navigate("/")}>
            Вернуться к документам
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      <div className="editor-topbar">
        <button className="icon-btn" onClick={() => navigate("/")} title="К документам">
          ←
        </button>
        <input
          className="editor-title-input"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Без названия"
        />
        <div className="editor-topbar-spacer" />
        <ShareLiveProjectButton url={window.location.href} className="btn btn-ghost share-live-btn" />
        <PresenceStack peers={peers} />
        <span className={`connection-pill ${status}`}>
          <span className="connection-dot" />
          {STATUS_LABEL[status]}
        </span>
        {user && <Avatar name={user.name} color={user.color} size={30} />}
      </div>

      <TypingStrip peers={peers} />

      <div className="editor-scroll">
        {!ready || !provider ? (
          <div className="editor-loading">
            <div className="spinner" />
            Загружаем документ…
          </div>
        ) : (
          // Keyed by doc id so navigating straight from one document to
          // another (without unmounting EditorPage) forces a fresh Quill
          // instance on a fresh DOM node, instead of re-initializing Quill
          // on top of its own previous markup.
          <Editor key={id} provider={provider} />
        )}
      </div>
    </div>
  );
}
