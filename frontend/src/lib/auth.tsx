"use client";

import { useEffect, useState, createContext, useContext, ReactNode } from "react";
import { getStored, setStored, clearStored } from "./store";

// Storage key under the app: prefix. `getStored`/`setStored` migrate the
// legacy "claude-web-token" value forward on first read.
const TOKEN_NAME = "token";

export function getToken(): string | null {
  return getStored(TOKEN_NAME);
}

export function setToken(token: string | null) {
  if (token) setStored(TOKEN_NAME, token);
  else clearStored(TOKEN_NAME);
}

export function authFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const t = getToken();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}

export type AuthUser = {
  id: number;
  username: string;
  role: "admin" | "member";
  display_name?: string | null;
};

type AuthCtx = {
  user: AuthUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
};

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthCtx["user"]>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      setLoading(false);
      return;
    }
    authFetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) {
          setToken(null);
          setUser(null);
        } else {
          const d = await r.json();
          setUser(d.user);
        }
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    setToken(d.token);
    setUser(d.user);
    return true;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}