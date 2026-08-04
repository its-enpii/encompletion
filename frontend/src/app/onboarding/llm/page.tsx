"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { BrandMark } from "@/components/ui/BrandMark";

/**
 * First-run onboarding — collects the user's OpenAI-compatible
 * provider endpoint + API key. Two-step flow:
 *   1. Test connection (`POST /api/llm-settings/test`) — surfaces
 *      precise errors (auth fail, timeout, network) so the user can
 *      fix their key without saving a broken config.
 *   2. Save (`PUT /api/llm-settings`) — encrypts the key server-side.
 *
 * After save we redirect to /chat/new. The SettingsGate stays satisfied
 * (configured=true) and the user's imported model list is empty until
 * they open the AI Settings dialog and click "Import models".
 */

export default function LlmOnboardingPage() {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<null | "ok" | "fail">(null);
  const [testError, setTestError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // If the user already has a saved config (e.g. navigated here
  // accidentally from the AI Settings dialog), pre-fill.
  useEffect(() => {
    (async () => {
      const r = await authFetch("/api/llm-settings");
      if (!r.ok) return;
      const j = await r.json();
      if (j.base_url) setBaseUrl(j.base_url);
    })();
  }, []);

  async function testConnection() {
    setBusy(true);
    setTestStatus(null);
    setTestError("");
    try {
      const r = await authFetch("/api/llm-settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_key: apiKey.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        setTestStatus("ok");
        setTestError("");
      } else {
        setTestStatus("fail");
        setTestError(j?.error || `HTTP ${r.status}`);
      }
    } catch (e: any) {
      setTestStatus("fail");
      setTestError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (testStatus !== "ok") {
      // Require a passing test before saving so we don't store a bad
      // key the user can't easily debug.
      return;
    }
    setBusy(true);
    try {
      const r = await authFetch("/api/llm-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          api_key: apiKey.trim() || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setTestStatus("fail");
        setTestError(j?.error || `HTTP ${r.status}`);
        return;
      }
      // Tell sibling tabs + the SettingsGate provider to refresh.
      if (typeof window !== "undefined") {
        const fn = (window as any).__encompletionBroadcastLlm;
        if (typeof fn === "function") fn();
      }
      router.replace("/chat/new");
    } catch (e: any) {
      setTestStatus("fail");
      setTestError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSave = testStatus === "ok" && baseUrl.trim().length > 0;

  return (
    <div className="grid min-h-dvh w-full place-items-center bg-[var(--paper)] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark size="md" />
          <h1 className="text-lg font-semibold tracking-tight text-[var(--ink)]">
            Hubungkan provider AI kamu
          </h1>
          <p className="max-w-sm text-sm text-[var(--ink-3)]">
            Setiap user membawa provider sendiri. Masukkan endpoint
            OpenAI-compatible + API key. Server akan mengenkripsi
            kuncinya di database lokal.
          </p>
        </div>

        <Card className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
              Base URL
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setTestStatus(null);
                setTestError("");
              }}
              placeholder="https://ai.example.com/v1"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)] focus:ring-2 focus:ring-[var(--magenta-500)]/15"
            />
            <p className="mt-1 text-[11px] text-[var(--ink-3)]">
              Contoh: <code>https://ai.enpiistudio.com/v1</code>,{" "}
              <code>https://openrouter.ai/api/v1</code>,{" "}
              <code>http://localhost:11434/v1</code>.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestStatus(null);
                  setTestError("");
                }}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)] focus:ring-2 focus:ring-[var(--magenta-500)]/15"
              />
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-pressed={showKey}
              >
                {showKey ? "Hide" : "Show"}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={testConnection} disabled={busy || !baseUrl.trim()} variant="default">
              {busy && testStatus === null ? "Testing…" : "Test connection"}
            </Button>
            <Button onClick={save} disabled={busy || !canSave} variant="primary">
              {busy && testStatus !== null ? "Menyimpan…" : "Simpan & mulai chat"}
            </Button>
          </div>

          {testStatus === "ok" && (
            <div className="rounded-[var(--r-md)] border border-[var(--success)]/40 bg-[var(--success-50)] px-3 py-2 text-sm text-[var(--success)]">
              Koneksi berhasil — provider merespons.
            </div>
          )}
          {testStatus === "fail" && testError && (
            <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
              {testError}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-[var(--ink-3)]">
            Setelah tersimpan, buka <strong>AI Settings</strong> di menu
            user untuk mengimpor daftar model dari endpoint ini. Model
            yang diimpor akan muncul di dropdown chat.
          </p>
        </Card>
      </div>
    </div>
  );
}