export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8081";

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  color: string;
}

export interface ApiDocument {
  id: string;
  title: string;
  icon: string;
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  updatedAt: string;
  createdAt: string;
  encrypted: boolean;
  forkedFromDocumentId: string | null;
}

export interface ApiSnapshot {
  id: string;
  createdAt: string;
}

export interface ApiTimelapseOp {
  id: string;
  createdAt: string;
}

export interface ApiBranch {
  id: string;
  title: string;
  icon: string;
  createdAt: string;
}

export interface ApiStateParts {
  encrypted: boolean;
  baseline: string | null;
  pending: string[];
}

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json().catch(() => ({})) : undefined;

  if (!response.ok) {
    const message = (body as { error?: string })?.error ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export const api = {
  register: (email: string, password: string, name: string) =>
    request<{ token: string; user: ApiUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: ApiUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ user: ApiUser }>("/api/auth/me"),

  listDocuments: () => request<{ documents: ApiDocument[] }>("/api/documents"),

  getDocument: (id: string) => request<{ document: ApiDocument }>(`/api/documents/${id}`),

  createDocument: (title?: string, icon?: string, options?: { encrypted?: boolean; initialState?: string }) =>
    request<{ document: ApiDocument }>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title, icon, ...options }),
    }),

  renameDocument: (id: string, title: string) =>
    request<{ ok: true }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  setDocumentIcon: (id: string, icon: string) =>
    request<{ ok: true }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ icon }),
    }),

  deleteDocument: (id: string) => request<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),

  listHistory: (id: string) => request<{ snapshots: ApiSnapshot[] }>(`/api/documents/${id}/history`),

  getHistorySnapshot: (id: string, snapshotId: string) =>
    request<{ state: string }>(`/api/documents/${id}/history/${snapshotId}`),

  restoreHistorySnapshot: (id: string, snapshotId: string) =>
    request<{ ok: true }>(`/api/documents/${id}/history/${snapshotId}/restore`, { method: "POST" }),

  listTimelapse: (id: string) => request<{ ops: ApiTimelapseOp[] }>(`/api/documents/${id}/timelapse`),

  getTimelapseUpdates: (id: string) => request<{ updates: string[] }>(`/api/documents/${id}/timelapse/updates`),

  getState: (id: string) => request<ApiStateParts>(`/api/documents/${id}/state`),

  listBranches: (id: string) => request<{ branches: ApiBranch[] }>(`/api/documents/${id}/branches`),

  createBranch: (id: string) => request<{ document: ApiDocument }>(`/api/documents/${id}/branch`, { method: "POST" }),
};

export { ApiError };
