"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { authFetch } from "./auth";

export type Model = {
  id: number;
  key: string;
  label: string;
  sort_order?: number;
  // Admin-only fields, present when listing with ?all=1.
  enabled?: boolean;
  created_at?: string;
  updated_at?: string | null;
};

type ModelsCtx = {
  models: Model[];
  loading: boolean;
  refresh: () => Promise<void>;
};

const ModelsContext = createContext<ModelsCtx>({
  models: [],
  loading: true,
  refresh: async () => {},
});

/**
 * Models registry — shared cache + socket subscription.
 *
 * One instance mounted at the root providers so the chat header dropdown
 * and the /models admin page both read the same `models` array. When the
 * backend emits `models:updated` (after any admin mutation), every
 * consumer refreshes — keeps multiple tabs in sync without a refetch on
 * every render.
 *
 * Uses authFetch so a 401 (e.g. hitting /models before login or after a
 * token expiry) routes the user back to /login via the standard auth
 * flow instead of bubbling JSON errors into the UI.
 */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch("/api/models");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setModels(Array.isArray(data) ? data : []);
    } catch {
      // silent: dropdown shouldn't break chat on registry fetch failure
      // (authFetch already bounces 401 to /login, no need to log here)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Socket: subscribe to admin-driven updates. We use the global
  // `socket.io-client` instance if available, else a long-poll fallback
  // would be needed — but the chat shell already mounts the socket in
  // `socket.ts`. Import here lazily so SSR doesn't choke on `window`.
  useEffect(() => {
    let socket: any = null;
    let detach: (() => void) | null = null;
    (async () => {
      try {
        const mod = await import("@/lib/socket");
        socket = mod.getSocket();
        if (!socket) return;
        const handler = () => { refresh(); };
        socket.on("models:updated", handler);
        detach = () => socket.off("models:updated", handler);
      } catch {
        /* socket not wired — refresh-on-mount fallback already in place */
      }
    })();
    return () => {
      if (detach) detach();
    };
  }, [refresh]);

  return (
    <ModelsContext.Provider value={{ models, loading, refresh }}>
      {children}
    </ModelsContext.Provider>
  );
}

export function useModels() {
  return useContext(ModelsContext);
}
