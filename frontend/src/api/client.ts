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
  ownerId: string;
  ownerName: string;
  isOwner: boolean;
  updatedAt: string;
  createdAt: string;
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

  createDocument: (title?: string) =>
    request<{ document: ApiDocument }>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  renameDocument: (id: string, title: string) =>
    request<{ ok: true }>(`/api/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteDocument: (id: string) =>
    request<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE" }),
};

export { ApiError };
