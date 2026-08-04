"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";
import { useLlmSettings } from "@/lib/llmSettings";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CenteredDialog } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";

/**
 * AI Settings dialog — fullscreen overlay exposing the user's
 * per-user provider config (base_url + masked api_key + import) plus
 * the imported model list. Parallels SystemPromptDialog.tsx's
 * structure but lives on the centered-modal axis so the import panel
 * has room to breathe.
 *
 * Two views the dialog toggles between:
 *   1. Settings tab: edit base_url, replace api_key, save.
 *   2. Import tab:    run /api/models/import, list the resulting models.
 *
 * Tabs keep state in URL-less local state (`mode: 'settings' | 'import'`).
 * On save we BroadcastChannel-ping siblings + the LlmSettingsProvider
 * so the chat header dropdown + SettingsGate refresh together.
 */

type Tab = "settings" | "import";

type ModelRow = {
  id: number;
  key: string;
  label: string;
  enabled: boolean;
  sort_order: number;
};

export function LlmSettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useUi();
  const { llm, refresh } = useLlmSettings();

  const [tab, setTab] = useState<Tab>("settings");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Settings draft
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Import draft
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    added: number;
    skipped_existing: number;
    upstream_count: number | null;
    error?: string;
  } | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  async function loadModels() {
    setModelsLoading(true);
    try {
      const r = await authFetch("/api/models?all=1");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setModels(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast(e?.message || "Gagal memuat model", "error");
    } finally {
      setModelsLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setImportResult(null);
    setTab("settings");
    setDraftBaseUrl(llm.base_url || "");
    setDraftApiKey("");
    setRevealKey(false);
    setClearKey(false);
    setLoading(false);
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function saveSettings() {
    setError(null);
    const trimmedUrl = draftBaseUrl.trim();
    if (!trimmedUrl) {
      setError("Base URL wajib diisi.");
      return;
    }
    // api_key: empty string → leave existing. null (via "Hapus") → delete.
    let apiKeyField: string | null | undefined = undefined;
    if (clearKey) {
      apiKeyField = null;
    } else if (draftApiKey.trim()) {
      apiKeyField = draftApiKey.trim();
    }
    setSaving(true);
    try {
      const r = await authFetch("/api/llm-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: trimmedUrl, api_key: apiKeyField }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      toast("Pengaturan AI disimpan", "success");
      // Tell siblings + provider to refresh.
      if (typeof window !== "undefined") {
        const fn = (window as any).__encompletionBroadcastLlm;
        if (typeof fn === "function") fn();
      }
      await refresh();
      setDraftApiKey("");
      setClearKey(false);
      setRevealKey(false);
      // Refresh model list (saved base_url + api_key are now active).
      loadModels();
    } catch (e: any) {
      setError(e?.message || "Gagal menyimpan");
    } finally {
      setSaving(false);
    }
  }

  async function runImport() {
    setImporting(true);
    setImportResult(null);
    try {
      const r = await authFetch("/api/models/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable_new: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setImportResult({
        added: j.added || 0,
        skipped_existing: j.skipped_existing || 0,
        upstream_count: j.upstream_count ?? null,
      });
      toast(
        `Import OK: +${j.added || 0} baru, ${j.skipped_existing || 0} sudah ada`,
        "success",
      );
      // Tell siblings to refresh models registry.
      if (typeof window !== "undefined") {
        const fn = (window as any).__encompletionBroadcastModels;
        if (typeof fn === "function") fn();
      }
      loadModels();
    } catch (e: any) {
      setImportResult({ added: 0, skipped_existing: 0, upstream_count: null, error: e?.message || "Import gagal" });
      toast(e?.message || "Import gagal", "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="AI Settings"
      description="Setiap user punya provider sendiri. Atur endpoint + API key, lalu impor model dari provider-mu."
      widthClass="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="flex gap-1 border-b border-[var(--line)]">
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
            Pengaturan
          </TabButton>
          <TabButton active={tab === "import"} onClick={() => setTab("import")}>
            Impor model
          </TabButton>
        </div>

        {tab === "settings" ? (
          <div className="space-y-3">
            <Card className="p-4">
              <div className="space-y-3">
                <Field label="Base URL">
                  <input
                    type="url"
                    value={draftBaseUrl}
                    onChange={(e) => setDraftBaseUrl(e.target.value)}
                    placeholder="https://ai.example.com/v1"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)] focus:ring-2 focus:ring-[var(--magenta-500)]/15"
                  />
                  <p className="mt-1 text-[11px] text-[var(--ink-3)]">
                    Endpoint <code>/chat/completions</code> +{" "}
                    <code>/models</code> harus tersedia di base URL ini.
                  </p>
                </Field>

                <Field
                  label="API Key"
                  hint={
                    llm.has_key
                      ? `Tersimpan: ${llm.masked_key ?? "••••"}`
                      : "Belum ada API key tersimpan"
                  }
                >
                  {!revealKey && llm.has_key && !draftApiKey ? (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2 font-mono text-xs text-[var(--ink-2)]">
                        {llm.masked_key ?? "••••"}
                      </code>
                      <Button variant="ghost" size="sm" onClick={() => setRevealKey(true)}>
                        Ganti
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          type={revealKey || draftApiKey ? "text" : "password"}
                          value={draftApiKey}
                          onChange={(e) => setDraftApiKey(e.target.value)}
                          placeholder={llm.has_key ? "Masukkan key baru untuk mengganti" : "sk-…"}
                          autoComplete="off"
                          spellCheck={false}
                          className="w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)] focus:ring-2 focus:ring-[var(--magenta-500)]/15"
                        />
                        {llm.has_key && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setClearKey(true);
                              setDraftApiKey("");
                            }}
                            title="Hapus API key tersimpan"
                          >
                            Hapus
                          </Button>
                        )}
                      </div>
                      {clearKey && (
                        <div className="text-[11px] text-[var(--warning)]">
                          API key akan dihapus dari database setelah simpan.
                        </div>
                      )}
                    </div>
                  )}
                </Field>

                {error && (
                  <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
                    {error}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    onClick={saveSettings}
                    disabled={saving || loading || !draftBaseUrl.trim()}
                    variant="primary"
                  >
                    {saving ? "Menyimpan…" : "Simpan pengaturan"}
                  </Button>
                  <span className="ml-auto">
                    <Pill tone={llm.configured ? "success" : "warning"}>
                      {llm.configured ? "configured" : "not configured"}
                    </Pill>
                  </span>
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <div className="space-y-3">
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ink)]">Impor dari endpoint</h3>
                  <p className="mt-0.5 text-xs text-[var(--ink-3)]">
                    Panggil <code>{"<base_url>/models"}</code> pakai
                    API key tersimpan, tambahkan model baru ke daftar
                    kamu.
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={runImport}
                  disabled={importing || !llm.configured}
                >
                  {importing ? "Mengimpor…" : "Impor sekarang"}
                </Button>
              </div>

              {!llm.configured && (
                <div className="rounded-[var(--r-md)] border border-[var(--warning)]/40 bg-[var(--warning-50)] px-3 py-2 text-sm text-[var(--warning)]">
                  Simpan base_url + API key dulu di tab Pengaturan.
                </div>
              )}

              {importResult && !importResult.error && (
                <div className="mb-3 rounded-[var(--r-md)] border border-[var(--success)]/40 bg-[var(--success-50)] px-3 py-2 text-sm text-[var(--success)]">
                  +{importResult.added} baru, {importResult.skipped_existing} sudah ada
                  {importResult.upstream_count != null && (
                    <> (upstream {importResult.upstream_count})</>
                  )}
                </div>
              )}
              {importResult?.error && (
                <div className="mb-3 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
                  {importResult.error}
                </div>
              )}

              <div className="mt-3 border-t border-[var(--line)] pt-3">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
                  Model kamu ({models.length})
                </h4>
                {modelsLoading ? (
                  <div className="text-sm text-[var(--ink-3)]">Memuat…</div>
                ) : models.length === 0 ? (
                  <div className="text-sm text-[var(--ink-3)]">
                    Belum ada model. Klik "Impor sekarang" untuk menarik dari endpoint.
                  </div>
                ) : (
                  <div className="grid max-h-64 gap-1 overflow-auto sm:grid-cols-2">
                    {models.map((m) => (
                      <div
                        key={m.id}
                        className={`flex items-center justify-between gap-2 rounded-[var(--r-sm)] border px-2 py-1.5 text-xs ${
                          m.enabled
                            ? "border-[var(--line)] bg-[var(--paper)]"
                            : "border-[var(--line)] bg-[var(--paper-2)] opacity-60"
                        }`}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-medium text-[var(--ink)]">{m.label}</span>
                          <code className="ml-1 text-[10px] text-[var(--ink-3)]">{m.key}</code>
                        </span>
                        <Pill tone={m.enabled ? "success" : "neutral"}>
                          {m.enabled ? "on" : "off"}
                        </Pill>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--magenta)] text-[var(--ink)]"
          : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
          {label}
        </label>
        {hint && <span className="text-[11px] text-[var(--ink-3)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}