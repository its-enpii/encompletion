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

const POLL_MS = 30_000;
const BC_NAME = "encompletion:models";

/**
 * Models registry — shared cache + polling refresh.
 *
 * Replaces the previous socket.io `models:updated` subscription with
 * 30s polling against /api/models. Mutations on the admin page are
 * infrequent (manual registry edits), so the latency is fine and we
 * avoid keeping a long-lived socket around just for one push event.
 *
 * Cross-tab sync: when this tab mutates the registry (rare — only the
 * admin /models page does), it broadcasts on `BC_NAME` so other tabs
 * refresh immediately instead of waiting up to 30s. Same-origin only;
 * remote admin on another machine still gets the next poll cycle.
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
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Cross-tab nudge: when ANY tab posts to this channel, refresh. Also
  // post on mount so a freshly-opened tab can request the freshest
  // snapshot from siblings (who then refresh + broadcast back).
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(BC_NAME);
    } catch {
      return; // some environments disable BC — fall back to polling alone
    }
    const onMsg = () => { refresh(); };
    bc.addEventListener("message", onMsg);
    return () => {
      bc.removeEventListener("message", onMsg);
      try { bc.close(); } catch { /* ignore */ }
    };
  }, [refresh]);

  // Expose a broadcaster via window so the admin page can ping siblings
  // immediately after a mutation, instead of waiting for the poll cycle.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const w = window as any;
    if (typeof w.__encompletionBroadcastModels === "function") return; // already wired
    w.__encompletionBroadcastModels = () => {
      try {
        const bc = new BroadcastChannel(BC_NAME);
        bc.postMessage("update");
        bc.close();
      } catch { /* ignore */ }
    };
    return () => {
      try { delete w.__encompletionBroadcastModels; } catch { /* ignore */ }
    };
  }, []);

  return (
    <ModelsContext.Provider value={{ models, loading, refresh }}>
      {children}
    </ModelsContext.Provider>
  );
}

export function useModels() {
  return useContext(ModelsContext);
}