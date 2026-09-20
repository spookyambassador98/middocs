import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Y from "yjs";
import { api, type ApiDocument } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import { CommandPalette, useCommandPalette, type Command } from "../components/CommandPalette";
import { bytesToBase64, encryptBytes, exportDocumentKey, generateDocumentKey } from "../editor/crypto";
import { cacheDocumentKey } from "../editor/keyStore";
import { DocumentCard } from "./DocumentCard";

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<ApiDocument[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDocuments()
      .then(({ documents }) => {
        if (!cancelled) setDocuments(documents);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load documents");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createDocument() {
    setCreating(true);
    try {
      const { document } = await api.createDocument();
      navigate(`/doc/${document.id}`);
    } catch {
      setError("Could not create the document");
      setCreating(false);
    }
  }

  // Zero-knowledge document: the encryption key is generated entirely in
  // this browser and never sent to the server. We build an empty Yjs
  // baseline, encrypt its bytes client-side, and send only ciphertext to
  // the API. The key is cached locally and also placed in the URL fragment
  // of the navigation target — the one part of a URL browsers never
  // transmit to a server — so the very first "share this link" already
  // carries working zero-knowledge access.
  async function createEncryptedDocument() {
    setCreating(true);
    try {
      const key = await generateDocumentKey();
      const seed = new Y.Doc();
      seed.getText("quill");
      const initialState = bytesToBase64(await encryptBytes(key, Y.encodeStateAsUpdate(seed)));
      seed.destroy();

      const keyStr = await exportDocumentKey(key);
      const { document } = await api.createDocument(undefined, "🔒", { encrypted: true, initialState });
      cacheDocumentKey(document.id, keyStr);
      navigate(`/doc/${document.id}#key=${keyStr}`);
    } catch {
      setError("Could not create the encrypted document");
      setCreating(false);
    }
  }

  async function renameDocument(id: string, title: string) {
    setDocuments((docs) => docs?.map((d) => (d.id === id ? { ...d, title } : d)) ?? docs);
    try {
      await api.renameDocument(id, title);
    } catch {
      setError("Could not rename the document");
    }
  }

  async function deleteDocument(id: string) {
    const previous = documents;
    setDocuments((docs) => docs?.filter((d) => d.id !== id) ?? docs);
    try {
      await api.deleteDocument(id);
    } catch {
      setError("Could not delete the document");
      setDocuments(previous);
    }
  }

  async function changeIcon(id: string, icon: string) {
    const previous = documents;
    setDocuments((docs) => docs?.map((d) => (d.id === id ? { ...d, icon } : d)) ?? docs);
    try {
      await api.setDocumentIcon(id, icon);
    } catch {
      setError("Could not change the icon");
      setDocuments(previous);
    }
  }

  const palette = useCommandPalette();
  const paletteCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: "new-doc", label: "New document", icon: "+", run: () => void createDocument() },
      {
        id: "new-doc-encrypted",
        label: "New encrypted document (zero-knowledge)",
        icon: "🔒",
        run: () => void createEncryptedDocument(),
      },
    ];
    for (const doc of documents ?? []) {
      cmds.push({
        id: `open-${doc.id}`,
        label: `Open: ${doc.title}`,
        icon: doc.icon,
        run: () => navigate(`/doc/${doc.id}`),
      });
    }
    cmds.push({ id: "logout", label: "Sign out", icon: "↩", run: logout });
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="logo-mark" />
          middocs
        </div>
        <div className="topbar-user">
          <button className="btn btn-ghost" title="Command palette (Ctrl+K)" onClick={() => palette.setOpen(true)}>
            ⌘K
          </button>
          {user && <Avatar name={user.name} color={user.color} size={34} />}
          <button className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="dashboard-header">
          <div>
            <h1>My documents</h1>
            <p>Open a doc with the team — edits show up live.</p>
          </div>
        </div>

        {error && <div className="form-error" style={{ maxWidth: 480 }}>{error}</div>}

        {documents === null ? (
          <div className="empty-state">
            <div className="spinner" style={{ margin: "0 auto" }} />
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="doc-icon" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              Aa
            </div>
            <h3 style={{ marginBottom: 6 }}>Nothing here yet</h3>
            <p style={{ marginBottom: 20 }}>Create the first document and invite people with the link.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={createDocument} disabled={creating}>
                + New document
              </button>
              <button
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={createEncryptedDocument}
                disabled={creating}
                title="Zero-knowledge: the server never sees the contents"
              >
                🔒 Encrypted
              </button>
            </div>
          </div>
        ) : (
          <div className="doc-grid">
            <div className="doc-card new-doc" onClick={createDocument}>
              <div style={{ fontSize: "1.8rem", marginBottom: 6 }}>{creating ? "…" : "+"}</div>
              New document
            </div>
            <div
              className="doc-card new-doc new-doc-encrypted"
              onClick={createEncryptedDocument}
              title="Zero-knowledge: the server never sees the contents"
            >
              <div style={{ fontSize: "1.8rem", marginBottom: 6 }}>🔒</div>
              Encrypted document
            </div>
            {documents.map((doc, i) => (
              <DocumentCard
                key={doc.id}
                document={doc}
                index={i}
                onRename={renameDocument}
                onDelete={deleteDocument}
                onIconChange={changeIcon}
              />
            ))}
          </div>
        )}
      </main>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} commands={paletteCommands} />
    </div>
  );
}
