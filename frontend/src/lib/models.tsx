"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";

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
 * The hook does NOT fetch the admin-only `?all=1` payload — pages that
 * need disabled rows fetch their own. This keeps the dropdown's network
 * request free of data members shouldn't see.
 */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/models", {
        headers: (() => {
          const h = new Headers();
          if (typeof window !== "undefined") {
            const t = window.localStorage.getItem("app:token")
              || window.localStorage.getItem("claude-web-token");
            if (t) h.set("Authorization", `Bearer ${t}`);
          }
          return h;
        })(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setModels(Array.isArray(data) ? data : []);
    } catch {
      // silent: dropdown shouldn't break chat on registry fetch failure
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
