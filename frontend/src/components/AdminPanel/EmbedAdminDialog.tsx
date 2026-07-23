"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { TextField } from "@/components/ui/TextField";
import { CenteredDialog } from "@/components/ui/Modal";
import { FullscreenOverlay } from "@/components/ui/FullscreenOverlay";

/**
 * EmbedAdminDialog — admin-only management surface for embed-mode
 * tenants. Supports tenant creation (TenantCreateDialog) and tenant
 * API key issuance (ApiKeyIssueDialog), plus the read-only drill-down
 * that shows capability / tools / executions / analytics for the
 * selected tenant.
 *
 * Endpoints exercised:
 *   GET    /api/admin/embed/tenants
 *   POST   /api/admin/embed/tenants
 *   GET    /api/admin/embed/tenants/:id/capability
 *   GET    /api/admin/embed/tenants/:id/tools
 *   GET    /api/admin/embed/tenants/:id/executions
 *   GET    /api/admin/embed/tenants/:id/analytics
 *   POST   /api/admin/embed/tenants/:id/api-keys
 *   POST   /api/admin/embed/tenants/:id/api-keys/:keyId/revoke
 */

type Tenant = {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended" | "trial";
  default_model_id: number | null;
  persona_config: string | null;
  created_at: string;
};

type Capability = {
  allow_artifact_generation: number;
  allow_bash: number;
  allowed_tool_ids: string;
  max_context_tokens: number | null;
  rate_limit_override: number | null;
} | null;

type Tool = {
  id: string;
  name: string;
  description: string;
  tool_category: string;
  endpoint_url: string;
  requires_confirmation: number;
  is_active: number;
};

type Execution = {
  id: string;
  tool_name: string | null;
  status: string;
  requested_at: string;
  error_message: string | null;
  message_preview: string | null;
};

type Analytics = {
  tenant: { id: string; name: string };
  since: string;
  totals: {
    sessions: number;
    messages: number;
    assistant_messages: number;
    total_cost_usd: number;
    total_tokens: number;
  };
  tools: {
    by_status: Record<string, number>;
    top: Array<{ tool_name: string; n: number }>;
  };
  daily: Array<{ day: string; messages: number; replies: number; cost_usd: number }>;
};

type TenantApiKey = {
  id: number;
  name: string;
  revoked_at: string | null;
  created_at: string;
};

export function EmbedAdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm: confirmDialog } = useUi();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [capability, setCapability] = useState<Capability>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [apiKeys, setApiKeys] = useState<TenantApiKey[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(true);
  const [creating, setCreating] = useState(false);
  const [issuingKey, setIssuingKey] = useState(false);

  // Load tenants list on open (admin only).
  useEffect(() => {
    if (!open) return;
    if (authLoading || me?.role !== "admin") return;
    setLoadingTenants(true);
    setSelectedId(null);
    authFetch("/api/admin/embed/tenants")
      .then((r) => r.ok ? r.json() : [])
      .then((rows) => setTenants(rows || []))
      .catch(() => setTenants([]))
      .finally(() => setLoadingTenants(false));
  }, [open, authLoading, me?.role]);

  // When a tenant is selected, fetch every related sub-resource in parallel.
  useEffect(() => {
    if (!selectedId) {
      setCapability(null);
      setTools([]);
      setExecutions([]);
      setAnalytics(null);
      setApiKeys([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [cap, toolList, execs, an, keys] = await Promise.all([
          authFetch(`/api/admin/embed/tenants/${selectedId}/capability`).then((r) => r.ok ? r.json() : null),
          authFetch(`/api/admin/embed/tenants/${selectedId}/tools`).then((r) => r.ok ? r.json() : []),
          authFetch(`/api/admin/embed/tenants/${selectedId}/executions?limit=20`).then((r) => r.ok ? r.json() : []),
          authFetch(`/api/admin/embed/tenants/${selectedId}/analytics`).then((r) => r.ok ? r.json() : null),
          authFetch(`/api/admin/embed/tenants/${selectedId}/api-keys`).then((r) => r.ok ? r.json() : []),
        ]);
        if (cancelled) return;
        setCapability(cap);
        setTools(toolList || []);
        setExecutions(execs || []);
        setAnalytics(an);
        setApiKeys(keys || []);
      } catch {
        /* swallow — partial state better than none */
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  const selectedTenant = tenants.find((t) => t.id === selectedId) || null;

  return (
    <FullscreenOverlay
      open={open}
      onClose={onClose}
      title="Embed tenants"
      subtitle={
        authLoading
          ? "Memuat…"
          : me?.role !== "admin"
            ? "Hanya admin."
            : "Kelola tenant embed — buat, lihat capability, daftar tools, audit eksekusi."
      }
      headerActions={
        me?.role === "admin" ? (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New tenant</span>
          </Button>
        ) : null
      }
    >
      {authLoading ? (
        <div className="grid place-items-center py-20 text-sm text-[var(--ink-3)]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--magenta)]" />
            Memuat…
          </div>
        </div>
      ) : me?.role !== "admin" ? (
        <Card className="p-10 text-center">
          <h2 className="text-base font-semibold text-[var(--ink)]">403 — Admin only</h2>
          <p className="mt-2 text-sm text-[var(--ink-3)]">
            Hanya admin yang dapat mengelola tenant embed.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* Sidebar list of tenants */}
          <Card className="p-2">
            <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
              Tenants
            </div>
            {loadingTenants ? (
              <div className="space-y-1.5 p-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded-[var(--r-sm)] bg-[var(--paper-2)]" />
                ))}
              </div>
            ) : tenants.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-[var(--ink-3)]">
                Belum ada tenant.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {tenants.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => setSelectedId(t.id)}
                      className={`flex w-full flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-sm transition-colors ${
                        selectedId === t.id
                          ? "bg-[var(--paper-2)] ring-1 ring-inset ring-[var(--line)]"
                          : "hover:bg-[var(--paper-2)]/50"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="truncate font-medium text-[var(--ink)]">{t.name}</span>
                        <Pill tone={t.status === "active" ? "success" : t.status === "trial" ? "info" : "danger"}>
                          {t.status}
                        </Pill>
                      </div>
                      <span className="truncate font-mono text-[10px] text-[var(--ink-3)]">{t.slug}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Detail pane */}
          <div className="min-w-0 space-y-4">
            {!selectedTenant ? (
              <Card className="p-10 text-center">
                <p className="text-sm font-medium text-[var(--ink)]">Pilih tenant</p>
                <p className="mt-1 text-xs text-[var(--ink-3)]">
                  Pilih tenant di sidebar untuk melihat capability, tools, executions, dan analytics.
                </p>
              </Card>
            ) : (
              <>
                <Card className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--ink)]">{selectedTenant.name}</h2>
                      <div className="mt-0.5 font-mono text-[11px] text-[var(--ink-3)]">{selectedTenant.id}</div>
                    </div>
                    <Pill tone={selectedTenant.status === "active" ? "success" : "danger"}>
                      {selectedTenant.status}
                    </Pill>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Mini label="Artifact gen" value={capability?.allow_artifact_generation ? "on" : "off"} tone={capability?.allow_artifact_generation ? "success" : "danger"} />
                    <Mini label="Bash" value={capability?.allow_bash ? "on" : "off"} tone={capability?.allow_bash ? "warning" : "danger"} />
                    <Mini label="Rate limit" value={capability?.rate_limit_override ? `${capability.rate_limit_override}/m` : "default"} tone="ink" />
                    <Mini label="Context tokens" value={capability?.max_context_tokens?.toString() || "default"} tone="ink" />
                  </div>
                </Card>

                {analytics && (
                  <Card className="p-5">
                    <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Analytics (since {analytics.since})</h3>
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <StatMini label="Sessions" value={analytics.totals.sessions} />
                      <StatMini label="Messages" value={analytics.totals.messages} />
                      <StatMini label="Replies" value={analytics.totals.assistant_messages} />
                      <StatMini label="Cost" value={`$${Number(analytics.totals.total_cost_usd || 0).toFixed(4)}`} />
                    </div>
                    {analytics.tools.top.length > 0 && (
                      <div className="mt-4">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">Top tools</div>
                        <ul className="space-y-1">
                          {analytics.tools.top.map((t) => (
                            <li key={t.tool_name} className="flex items-center justify-between rounded-[var(--r-sm)] bg-[var(--paper-2)] px-3 py-1.5 text-xs">
                              <span className="font-mono text-[var(--ink-2)]">{t.tool_name}</span>
                              <span className="tabular-nums font-semibold text-[var(--ink)]">{t.n}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </Card>
                )}

                <Card className="p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">Tools (Kategori B)</h3>
                    <span className="text-[10px] text-[var(--ink-3)]">{tools.length} terdaftar</span>
                  </div>
                  {tools.length === 0 ? (
                    <p className="text-xs text-[var(--ink-3)]">Belum ada tool. Daftarkan via API atau admin CLI.</p>
                  ) : (
                    <ul className="divide-y divide-[var(--line)]">
                      {tools.map((t) => (
                        <li key={t.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                          <span className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${t.is_active ? "bg-[var(--success)]" : "bg-[var(--danger)]"}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm font-semibold text-[var(--ink)]">{t.name}</span>
                              <Pill tone={t.tool_category === "business_action" ? "info" : "neutral"}>{t.tool_category}</Pill>
                              {t.requires_confirmation ? <Pill tone="warning">confirm</Pill> : null}
                            </div>
                            <div className="truncate text-xs text-[var(--ink-3)]">{t.endpoint_url}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card className="p-5">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Recent tool executions</h3>
                  {executions.length === 0 ? (
                    <p className="text-xs text-[var(--ink-3)]">Belum ada eksekusi.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {executions.map((e) => (
                        <li key={e.id} className="flex items-start gap-2 rounded-[var(--r-sm)] bg-[var(--paper-2)]/60 px-3 py-2 text-xs">
                          <span className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                            e.status === "executed" ? "bg-[var(--success)]"
                              : e.status === "failed" ? "bg-[var(--danger)]"
                              : e.status === "pending_confirmation" ? "bg-[var(--warning)]"
                              : "bg-[var(--ink-3)]"
                          }`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[var(--ink-2)]">{e.tool_name || "(unknown)"}</span>
                              <Pill tone={
                                e.status === "executed" ? "success"
                                  : e.status === "failed" ? "danger"
                                  : e.status === "pending_confirmation" ? "warning"
                                  : "neutral"
                              }>{e.status}</Pill>
                              <span className="text-[var(--ink-3)]">{new Date(e.requested_at).toLocaleString("id-ID")}</span>
                            </div>
                            {e.error_message && (
                              <div className="mt-0.5 truncate text-[var(--danger)]">{e.error_message}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tenant API key card — sits inside the FullscreenOverlay
          (rendered as the last section in the detail pane when a
          tenant is selected). The "Issue API key" button opens
          ApiKeyIssueDialog. */}
      {selectedTenant && (
        <Card className="mt-4 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--ink)]">API keys</h3>
            <Button variant="primary" size="sm" onClick={() => setIssuingKey(true)}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Issue API key</span>
            </Button>
          </div>
          {apiKeys.length === 0 ? (
            <p className="text-xs text-[var(--ink-3)]">
              Belum ada API key. Issue satu untuk dibagikan ke customer (server-to-server).
            </p>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {apiKeys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--ink)]">{k.name}</span>
                      {k.revoked_at ? <Pill tone="danger">revoked</Pill> : <Pill tone="success">active</Pill>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                      Dibuat {formatDate(k.created_at)}
                    </div>
                  </div>
                  {!k.revoked_at && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: "Cabut API key",
                          message: `Key "${k.name}" akan langsung tidak bisa dipakai. Lanjutkan?`,
                          confirmLabel: "Cabut",
                          destructive: true,
                        });
                        if (!ok) return;
                        try {
                          const r = await authFetch(
                            `/api/admin/embed/tenants/${selectedTenant.id}/api-keys/${k.id}/revoke`,
                            { method: "POST" }
                          );
                          if (!r.ok) {
                            const d = await r.json().catch(() => ({}));
                            throw new Error(d.error || `HTTP ${r.status}`);
                          }
                          toast("Key dicabut", "success");
                          // Refresh key list.
                          const list = await authFetch(`/api/admin/embed/tenants/${selectedTenant.id}/api-keys`).then((r) => r.ok ? r.json() : []);
                          setApiKeys(list || []);
                        } catch (e: any) {
                          toast(e?.message || "Gagal mencabut", "error");
                        }
                      }}
                    >
                      <span className="text-[var(--danger)]">Cabut</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <TenantCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setCreating(false);
          setTenants((cur) => [t, ...cur]);
          setSelectedId(t.id);
          toast(`Tenant "${t.name}" dibuat`, "success");
        }}
      />

      <ApiKeyIssueDialog
        open={issuingKey && !!selectedTenant}
        tenantId={selectedTenant?.id || ""}
        tenantName={selectedTenant?.name || ""}
        onClose={() => setIssuingKey(false)}
        onIssued={(key) => {
          setApiKeys((cur) => [{ id: key.id, name: key.name, revoked_at: null, created_at: new Date().toISOString() }, ...cur]);
        }}
      />
    </FullscreenOverlay>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone: "success" | "danger" | "warning" | "ink" }) {
  const toneClass = {
    success: "bg-[var(--success-50)] text-[var(--success)]",
    danger: "bg-[var(--danger-50)] text-[var(--danger)]",
    warning: "bg-[var(--saffron-50)] text-[var(--saffron-500)]",
    ink: "bg-[var(--paper-2)] text-[var(--ink-2)]",
  }[tone];
  return (
    <div className={`flex flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-3 py-2 ${toneClass}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.06em] opacity-70">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}

function StatMini({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--r-sm)] bg-[var(--paper-2)] px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--ink-3)]">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

// ---- TenantCreateDialog --------------------------------------------------
//
// CenteredDialog form: name + slug (auto-derived from name, override
// allowed) + status + default_model_id + optional persona fields.
// On submit → POST /tenants, callback with the new row.

function TenantCreateDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const { toast } = useUi();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState<"active" | "trial" | "suspended">("active");
  const [defaultModelId, setDefaultModelId] = useState<string>("");
  const [models, setModels] = useState<Array<{ id: number; key: string; label: string }>>([]);
  const [personaName, setPersonaName] = useState("");
  const [personaTone, setPersonaTone] = useState("");
  const [personaGreeting, setPersonaGreeting] = useState("");
  const [personaInstructions, setPersonaInstructions] = useState("");
  const [showPersona, setShowPersona] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load model registry once when dialog opens so the select has options.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch("/api/models?enabled_only=1")
      .then((r) => r.ok ? r.json() : [])
      .then((rows) => { if (!cancelled) setModels(rows || []); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [open]);

  // Auto-derive kebab slug from name (until user manually edits).
  const autoSlug = useMemo(() => {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }, [name]);
  const effectiveSlug = slugTouched ? slug : autoSlug;
  const slugValid = /^[a-z0-9][a-z0-9-]*$/.test(effectiveSlug);

  // Reset form each open.
  useEffect(() => {
    if (!open) return;
    setName(""); setSlug(""); setSlugTouched(false);
    setStatus("active"); setDefaultModelId("");
    setPersonaName(""); setPersonaTone("");
    setPersonaGreeting(""); setPersonaInstructions("");
    setShowPersona(false); setError(null);
  }, [open]);

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("Nama wajib diisi");
    if (!slugValid) return setError("Slug harus kebab-case (huruf kecil, angka, dash)");
    setSubmitting(true);
    try {
      const persona: Record<string, unknown> = {};
      if (personaName.trim()) persona.name = personaName.trim();
      if (personaTone.trim()) persona.tone = personaTone.trim();
      if (personaGreeting.trim()) persona.greeting = personaGreeting.trim();
      if (personaInstructions.trim()) persona.instructions = personaInstructions.trim();

      const r = await authFetch("/api/admin/embed/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: effectiveSlug,
          status,
          default_model_id: defaultModelId ? Number(defaultModelId) : null,
          persona_config: Object.keys(persona).length > 0 ? persona : undefined,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const created = await r.json();
      onCreated(created);
    } catch (e: any) {
      setError(e?.message || "Gagal membuat tenant");
      toast(e?.message || "Gagal membuat tenant", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="New tenant"
      description="Daftarkan tenant baru. Setelah dibuat, issue API key untuk dibagikan ke customer (server-to-server)."
      widthClass="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Batal</Button>
          <Button variant="primary" onClick={submit} disabled={submitting}>
            {submitting ? "Membuat…" : "Buat tenant"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="LaundryAja" autoFocus />
        <TextField
          label="Slug (kebab-case, unik)"
          value={slugTouched ? slug : autoSlug}
          onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }}
          placeholder={autoSlug || "laundryaja"}
          hint={slugValid ? "✓ valid" : "Format: huruf kecil, angka, dash"}
        />
        <div className="flex items-center gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--ink-2)]">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]">
              <option value="active">active</option>
              <option value="trial">trial</option>
              <option value="suspended">suspended</option>
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-[var(--ink-2)]">
            Default model
            <select value={defaultModelId} onChange={(e) => setDefaultModelId(e.target.value)} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]">
              <option value="">— none —</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.key})</option>)}
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={() => setShowPersona((v) => !v)}
          className="text-[11px] font-medium text-[var(--magenta-600)] hover:text-[var(--magenta-700)]"
        >
          {showPersona ? "− Hide" : "+ Show"} advanced (persona)
        </button>
        {showPersona && (
          <div className="space-y-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]/50 p-3">
            <TextField label="Persona name (bot)" value={personaName} onChange={(e) => setPersonaName(e.target.value)} placeholder="Aira" />
            <TextField label="Tone" value={personaTone} onChange={(e) => setPersonaTone(e.target.value)} placeholder="friendly, singkat" />
            <TextField label="Greeting" value={personaGreeting} onChange={(e) => setPersonaGreeting(e.target.value)} placeholder="Halo! Ada yang bisa dibantu?" />
            <div>
              <label className="label mb-1.5 block">Instructions</label>
              <textarea
                value={personaInstructions}
                onChange={(e) => setPersonaInstructions(e.target.value)}
                rows={3}
                className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] p-2.5 font-mono text-xs text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                placeholder="Aturan tambahan untuk bot tenant ini…"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}

// ---- ApiKeyIssueDialog ---------------------------------------------------
//
// CenteredDialog with name input + plaintext banner shown ONCE after
// successful POST. Plaintext is never re-served by the server — the
// banner is the only opportunity to copy it.

function ApiKeyIssueDialog({
  open, tenantId, tenantName, onClose, onIssued,
}: {
  open: boolean;
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  onIssued: (key: { id: number; name: string; plaintext: string; prefix: string }) => void;
}) {
  const { toast } = useUi();
  const [name, setName] = useState("primary");
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<{ id: number; name: string; plaintext: string; prefix: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("primary"); setIssued(null); setCopied(false); setError(null);
  }, [open]);

  async function submit() {
    if (!name.trim()) return setError("Nama wajib diisi");
    if (!tenantId) return setError("Tenant tidak dipilih");
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(`/api/admin/embed/tenants/${tenantId}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      setIssued(j);
      onIssued(j);
    } catch (e: any) {
      setError(e?.message || "Gagal issue key");
      toast(e?.message || "Gagal issue key", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.plaintext);
      setCopied(true);
      toast("Key disalin ke clipboard", "success");
    } catch {
      toast("Gagal menyalin — pilih manual lalu salin", "error");
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title={`Issue API key untuk "${tenantName}"`}
      description="Plaintext hanya ditampilkan sekali — server hanya menyimpan hash-nya. Customer app akan mengirim key ini via Authorization: Bearer."
      widthClass="max-w-md"
      footer={
        issued ? (
          <Button variant="primary" onClick={onClose}>Tutup</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>Batal</Button>
            <Button variant="primary" onClick={submit} disabled={submitting || !name.trim()}>
              {submitting ? "Issuing…" : "Issue"}
            </Button>
          </>
        )
      }
    >
      {!issued ? (
        <TextField
          label="Nama key"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="primary"
          autoFocus
          hint="Mis. 'primary', 'staging', 'mobile-app'. Hanya untuk identifikasi internal."
        />
      ) : (
        <div className="space-y-3">
          <div className="rounded-[var(--r-md)] border border-[var(--saffron-300)] bg-[var(--saffron-50)] px-3 py-2">
            <div className="text-sm font-semibold text-[var(--saffron-700)]">
              Key baru — salin sekarang
            </div>
            <p className="mt-1 text-xs text-[var(--ink-2)]">
              Plaintext hanya ditampilkan sekali. Server hanya menyimpan hash-nya.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="block max-w-full overflow-x-auto whitespace-pre rounded-[var(--r-md)] bg-[var(--paper)] px-3 py-2 font-mono text-xs text-[var(--ink)]">
              {issued.plaintext}
            </code>
            <Button variant="primary" size="sm" onClick={copy}>
              {copied ? "Tersalin ✓" : "Salin"}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
    </CenteredDialog>
  );
}