import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiDocument } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
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
        if (!cancelled) setError("Не удалось загрузить документы");
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
      setError("Не удалось создать документ");
      setCreating(false);
    }
  }

  async function renameDocument(id: string, title: string) {
    setDocuments((docs) => docs?.map((d) => (d.id === id ? { ...d, title } : d)) ?? docs);
    try {
      await api.renameDocument(id, title);
    } catch {
      setError("Не удалось переименовать документ");
    }
  }

  async function deleteDocument(id: string) {
    const previous = documents;
    setDocuments((docs) => docs?.filter((d) => d.id !== id) ?? docs);
    try {
      await api.deleteDocument(id);
    } catch {
      setError("Не удалось удалить документ");
      setDocuments(previous);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="logo-mark" />
          Draft
        </div>
        <div className="topbar-user">
          {user && <Avatar name={user.name} color={user.color} size={34} />}
          <button className="btn btn-ghost" onClick={logout}>
            Выйти
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="dashboard-header">
          <div>
            <h1>Мои документы</h1>
            <p>Открывайте документ вместе с командой — правки видно вживую.</p>
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
            <h3 style={{ marginBottom: 6 }}>Пока пусто</h3>
            <p style={{ marginBottom: 20 }}>Создайте первый документ и пригласите коллег по ссылке.</p>
            <button className="btn btn-primary" style={{ width: "auto" }} onClick={createDocument} disabled={creating}>
              + Новый документ
            </button>
          </div>
        ) : (
          <div className="doc-grid">
            <div className="doc-card new-doc" onClick={createDocument}>
              <div style={{ fontSize: "1.8rem", marginBottom: 6 }}>{creating ? "…" : "+"}</div>
              Новый документ
            </div>
            {documents.map((doc, i) => (
              <DocumentCard key={doc.id} document={doc} index={i} onRename={renameDocument} onDelete={deleteDocument} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
