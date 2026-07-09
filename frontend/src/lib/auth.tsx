"use client";

import { useEffect, useState, createContext, useContext, ReactNode } from "react";
import { getStored, setStored, clearStored } from "./store";

// Storage key under the app: prefix. `getStored`/`setStored` migrate the
// legacy "claude-web-token" value forward on first read.
const TOKEN_NAME = "token";

// Track the current pathname so `authFetch` only triggers an auth-driven
// redirect when the user is hitting a route that actually requires auth.
// We also defer the redirect by one tick so we never call
// `router.push` during the render of a child component.
let currentPathname = "/";
function notifyOnUnauthorized() {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  // Use replace instead of push so the back button doesn't trap the
  // user in a logout↔login loop if their last interaction was a click
  // on a dead token.
  window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
}

export function getToken(): string | null {
  return getStored(TOKEN_NAME);
}

export function setToken(token: string | null) {
  if (token) setStored(TOKEN_NAME, token);
  else clearStored(TOKEN_NAME);
}

export function setCurrentPathname(p: string) {
  currentPathname = p || "/";
}

export function authFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const t = getToken();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers }).then(async (res) => {
    // 401 = backend says "your token is bad". Clear it and bounce to
    // /login so the user re-authenticates instead of seeing cryptic
    // JSON errors. Skip when we're already on /login to avoid an
    // infinite replace loop on the form's own submit failures.
    if (res.status === 401 && currentPathname !== "/login") {
      setToken(null);
      notifyOnUnauthorized();
      // Throw a typed error so callers' `.catch` blocks can branch.
      throw new Error("unauthorized");
    }
    return res;
  });
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