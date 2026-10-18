import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Quill from "quill";
import { QuillBinding } from "y-quill";
import "quill/dist/quill.snow.css";
import { api } from "../api/client";
import { registerQuillExtensions } from "./quillSetup";
import { SpectatorProvider, type SpectatorStatus } from "./SpectatorProvider";
import { PresenceStack } from "./PresenceBar";
import { useAwarenessStates } from "./useAwarenessStates";

registerQuillExtensions();

const STATUS_LABEL: Record<SpectatorStatus, string> = {
  connecting: "Connecting…",
  connected: "Online",
  disconnected: "Offline",
};

/**
 * The public, no-login "watch live" page — a completely separate access
 * tier from editing (see SpectatorProvider.ts). No toolbar, no comments,
 * no drawers: just the document rendering itself as it's edited, with a
 * presence stack for who's currently in it. Nothing here is Google
 * Docs/Notion/Confluence, all of which require an account just to view.
 */
export default function SpectatePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ title: string; icon: string } | null>(null);
  const [provider, setProvider] = useState<SpectatorProvider | null>(null);
  const [status, setStatus] = useState<SpectatorStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .getSpectateInfo(token)
      .then((data) => {
        if (!cancelled) setInfo({ title: data.title, icon: data.icon });
      })
      .catch(() => {
        if (!cancelled) setError("This watch link is invalid, or the broadcast is off");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || error) return;
    const p = new SpectatorProvider(token);
    setProvider(p);
    const offStatus = p.onStatusChange(setStatus);
    const offError = p.onError(setError);
    const offReady = p.onReady(({ title, icon }) => setInfo({ title, icon }));
    return () => {
      offStatus();
      offError();
      offReady();
      p.destroy();
      setProvider(null);
    };
    // `error` intentionally excluded — once set, this effect's own cleanup
    // already tore the provider down; we don't want a later unrelated
    // error flowing back through and recreating the connection loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!provider || !containerRef.current || quillRef.current) return;
    const quill = new Quill(containerRef.current, {
      readOnly: true,
      modules: { toolbar: false, cursors: { transformOnTextChange: true } },
    });
    quillRef.current = quill;
    const ytext = provider.doc.getText("quill");
    const binding = new QuillBinding(ytext, quill, provider.awareness);
    return () => {
      binding.destroy();
      quillRef.current = null;
    };
  }, [provider]);

  const peers = useAwarenessStates(provider?.awareness ?? null, null);

  if (error) {
    return (
      <div className="editor-loading">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      <div className="editor-topbar">
        <span className="live-badge">🔴 LIVE</span>
        <span style={{ fontSize: "1.3rem" }}>{info?.icon ?? "📄"}</span>
        <div className="editor-title-input" style={{ fontWeight: 700, cursor: "default" }}>
          {info?.title || "Loading…"}
        </div>
        <div className="editor-topbar-spacer" />
        <PresenceStack peers={peers} />
        <span className={`connection-pill ${status}`}>
          <span className="connection-dot" />
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div className="editor-scroll">
        <div className="editor-body">
          <div className="editor-page-frame">
            <div ref={containerRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
