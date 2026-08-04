"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { authFetch } from "./auth";

/**
 * Per-user LLM settings — `configured`, `has_key`, `baseUrl`, masked key,
 * and the per-user imported model list. Polls /api/auth/me (cheap, ~once
 * per minute) so changes in another tab refresh here, and exposes a
 * `refresh()` for the dialog to call after a save.
 *
 * The first-run SettingsGate (components/SettingsGate.tsx) reads
 * `configured` to decide whether to bounce the user to /onboarding/llm.
 */

export type LlmSettings = {
  configured: boolean;
  has_key: boolean;
  base_url_set: boolean;
  base_url: string;
  masked_key: string | null;
  compaction_model: string | null;
  extraction_model: string | null;
  updated_at?: string | null;
};

type LlmCtx = {
  llm: LlmSettings;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Open the LLM Settings dialog from anywhere — mounted on window. */
  openSettings: () => void;
};

const DEFAULT_LLM: LlmSettings = {
  configured: false,
  has_key: false,
  base_url_set: false,
  base_url: "",
  masked_key: null,
  compaction_model: null,
  extraction_model: null,
};

const LlmSettingsContext = createContext<LlmCtx>({
  llm: DEFAULT_LLM,
  loading: true,
  refresh: async () => {},
  openSettings: () => {},
});

const POLL_MS = 60_000;
const BC_NAME = "encompletion:llm";

export function LlmSettingsProvider({ children }: { children: ReactNode }) {
  const [llm, setLlm] = useState<LlmSettings>(DEFAULT_LLM);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await authFetch("/api/auth/me");
      if (!r.ok) return;
      const data = await r.json();
      const incoming = data?.llm_settings;
      if (!incoming) return;
      // /api/auth/me only ships the booleans; the full detail (base_url,
      // masked_key, model overrides) comes from /api/llm-settings. We
      // call both and merge so the UI always shows the freshest.
      const detail = await authFetch("/api/llm-settings").then((r2) => (r2.ok ? r2.json() : null));
      setLlm({
        configured: !!incoming.configured,
        has_key: !!incoming.has_key,
        base_url_set: !!incoming.base_url_set,
        base_url: detail?.base_url ?? "",
        masked_key: detail?.masked_key ?? null,
        compaction_model: detail?.compaction_model ?? null,
        extraction_model: detail?.extraction_model ?? null,
        updated_at: detail?.updated_at ?? null,
      });
    } catch {
      // Silent: SettingsGate will keep polling; the user sees the spinner.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Cross-tab nudge — when any tab saves new settings, refresh here.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(BC_NAME);
    } catch {
      return;
    }
    const onMsg = () => { refresh(); };
    bc.addEventListener("message", onMsg);
    // Ask siblings for fresh data on mount.
    bc.postMessage("update");
    return () => {
      bc.removeEventListener("message", onMsg);
      try { bc.close(); } catch {}
    };
  }, [refresh]);

  // BroadcastChannel helper exposed via window for the dialog / page to
  // ping siblings after a save. Same pattern as models.tsx.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const w = window as any;
    if (typeof w.__encompletionBroadcastLlm === "function") return;
    w.__encompletionBroadcastLlm = () => {
      try {
        const bc = new BroadcastChannel(BC_NAME);
        bc.postMessage("update");
        bc.close();
      } catch {}
    };
    return () => {
      try { delete w.__encompletionBroadcastLlm; } catch {}
    };
  }, []);

  // Window-level event that opens the AI Settings dialog from anywhere.
  // The dialog lives in AdminPanelHost; we just dispatch an event the
  // host listens for. Same UX shape as `admin:open-prompt`.
  const openSettings = useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("app:open-llm-settings"));
    }
  }, []);

  return (
    <LlmSettingsContext.Provider value={{ llm, loading, refresh, openSettings }}>
      {children}
    </LlmSettingsContext.Provider>
  );
}

export function useLlmSettings() {
  return useContext(LlmSettingsContext);
}