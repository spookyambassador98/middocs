import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAuthToken, type ApiUser } from "../api/client";

interface AuthState {
  user: ApiUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const STORAGE_KEY = "mgd:auth";

interface StoredAuth {
  token: string;
  user: ApiUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StoredAuth;
        setAuthToken(parsed.token);
        setToken(parsed.token);
        setUser(parsed.user);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    setLoading(false);
  }, []);

  const persist = useCallback((next: StoredAuth | null) => {
    if (next) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setAuthToken(next.token);
      setToken(next.token);
      setUser(next.user);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      setAuthToken(null);
      setToken(null);
      setUser(null);
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email, password);
      persist(result);
    },
    [persist]
  );

  const register = useCallback(
    async (email: string, password: string, name: string) => {
      const result = await api.register(email, password, name);
      persist(result);
    },
    [persist]
  );

  const logout = useCallback(() => persist(null), [persist]);

  const value = useMemo(
    () => ({ user, token, loading, login, register, logout }),
    [user, token, loading, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
