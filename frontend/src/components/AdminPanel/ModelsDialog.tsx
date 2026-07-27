"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { CenteredDialog } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { FullscreenOverlay } from "@/components/ui/FullscreenOverlay";

/**
 * Models admin panel — fullscreen overlay. Surfaces the registry
 * list + stat tiles + grid cards + edit/create/delete with a sibling
 * broadcast notification so other tabs refresh the dropdown
 * immediately.
 */

type Model = {
  id: number;
  key: string;
  label: string;
  enabled?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string | null;
};

type ModelPayload = {
  key?: string;
  label?: string;
  enabled?: boolean;
  sort_order?: number;
};

function pingSiblings() {
  if (typeof window === "undefined") return;
  const fn = (window as any).__encompletionBroadcastModels;
  if (typeof fn === "function") fn();
}

export function ModelsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm } = useUi();
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<
    { kind: "create" } | { kind: "edit"; model: Model } | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [roleIds, setRoleIds] = useState<string[]>(["admin", "member"]);
  const [grants, setGrants] = useState<Record<string, string[]>>({
    admin: [],
    member: [],
  });
  const [grantRole, setGrantRole] = useState<string>("member");
  const [grantDraft, setGrantDraft] = useState<string[]>([]);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantQuery, setGrantQuery] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rModels, rGrants] = await Promise.all([
        authFetch("/api/models?all=1"),
        authFetch("/api/models/role-access"),
      ]);
      if (!rModels.ok) {
        const d = await rModels.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${rModels.status}`);
      }
      setModels(await rModels.json());
      if (rGrants.ok) {
        const g = await rGrants.json();
        const ids: string[] = Array.isArray(g?.roles) && g.roles.length
          ? g.roles.map(String)
          : ["admin", "member"];
        setRoleIds(ids);
        const next: Record<string, string[]> = {};
        for (const id of ids) {
          next[id] = Array.isArray(g?.grants?.[id]) ? g.grants[id] : [];
        }
        setGrants(next);
        const active = ids.includes(grantRole) ? grantRole : ids.includes("member") ? "member" : ids[0];
        setGrantRole(active);
        setGrantDraft(next[active] || []);
      }
    } catch (e: any) {
      setError(e.message || "failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (authLoading || me?.role !== "admin") return;
    load();
    setModal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.role]);

  useEffect(() => {
    setGrantDraft(grants[grantRole] || []);
  }, [grantRole, grants]);

  const stats = useMemo(() => ({
    total: models.length,
    enabled: models.filter((m) => m.enabled).length,
    disabled: models.filter((m) => !m.enabled).length,
  }), [models]);

  async function saveModal(payload: ModelPayload) {
    if (!modal) return;
    const url = modal.kind === "create" ? "/api/models" : `/api/models/${modal.model.id}`;
    const method = modal.kind === "create" ? "POST" : "PATCH";
    const r = await authFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    setModal(null);
    await load();
    pingSiblings();
  }

  async function disable(m: Model) {
    if (stats.enabled <= 1) {
      toast("Tidak bisa menonaktifkan model terakhir", "error");
      return;
    }
    const ok = await confirm({
      title: "Nonaktifkan model",
      message: "Model ini akan hilang dari pilihan chat. Data historis tetap ada.",
      confirmLabel: "Nonaktifkan",
      destructive: true,
    });
    if (!ok) return;
    const r = await authFetch(`/api/models/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast(d.error || "Gagal menonaktifkan", "error");
      return;
    }
    await load();
    pingSiblings();
  }

  async function enable(m: Model) {
    const r = await authFetch(`/api/models/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast(d.error || "Gagal mengaktifkan", "error");
      return;
    }
    await load();
    pingSiblings();
  }

  async function importFromEndpoint() {
    if (importing) return;
    setImporting(true);
    try {
      const r = await authFetch("/api/models/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable_new: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast(
        `Import OK: +${d.added || 0} baru, ${d.skipped_existing || 0} sudah ada` +
          (d.upstream_count != null ? ` (upstream ${d.upstream_count})` : ""),
        "success"
      );
      await load();
      pingSiblings();
    } catch (e: any) {
      toast(e?.message || "Import gagal", "error");
    } finally {
      setImporting(false);
    }
  }

  async function saveRoleGrants() {
    setGrantBusy(true);
    try {
      const r = await authFetch("/api/models/role-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: grantRole, model_keys: grantDraft }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setGrants((prev) => ({ ...prev, [grantRole]: d.model_keys || [] }));
      toast(
        d.unrestricted
          ? `Role ${grantRole}: unrestricted (semua model enabled)`
          : `Role ${grantRole}: ${ (d.model_keys || []).length } model`,
        "success"
      );
      pingSiblings();
    } catch (e: any) {
      toast(e?.message || "Gagal simpan RBAC", "error");
    } finally {
      setGrantBusy(false);
    }
  }

  function toggleGrantKey(key: string) {
    setGrantDraft((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  const headerActions = me?.role === "admin" ? (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={importFromEndpoint} disabled={importing}>
        {importing ? "Import…" : "Import dari endpoint"}
      </Button>
      <Button variant="primary" size="sm" onClick={() => setModal({ kind: "create" })}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>Tambah model</span>
      </Button>
    </div>
  ) : null;

  return (
    <>
      <FullscreenOverlay
        open={open}
        onClose={onClose}
        title="Model registry"
        subtitle={
          authLoading
            ? "Memuat…"
            : me?.role !== "admin"
              ? "Hanya admin yang dapat melihat halaman ini."
              : "Kelola model yang tersedia di dropdown chat. Daftar ini hanya memfilter apa yang dikirim lewat --model ke backend."
        }
        headerActions={headerActions}
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
              Buka sebagai admin untuk mengelola model.
            </p>
          </Card>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-3 gap-3">
              <StatTile label="Total" value={stats.total} tone="ink" />
              <StatTile label="Enabled" value={stats.enabled} tone="success" />
              <StatTile label="Disabled" value={stats.disabled} tone="danger" />
            </div>

            {error && (
              <div className="mb-4 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
                {error}
              </div>
            )}

            {loading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="card h-40 animate-pulse" />
                ))}
              </div>
            ) : models.length === 0 ? (
              <Card className="p-10 text-center">
                <p className="text-sm font-medium text-[var(--ink)]">Belum ada model</p>
                <p className="mt-1 text-xs text-[var(--ink-3)]">Tambah model pertama untuk mulai.</p>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {models
                  .slice()
                  .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
                  .map((m) => (
                    <ModelCard
                      key={m.id}
                      model={m}
                      onEdit={() => setModal({ kind: "edit", model: m })}
                      onEnable={() => enable(m)}
                      onDisable={() => disable(m)}
                    />
                  ))}
              </div>
            )}

            <Card className="mt-6 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ink)]">Akses model per role (RBAC)</h3>
                  <p className="mt-0.5 text-xs text-[var(--ink-3)]">
                    Kosong = unrestricted (semua model enabled). Centang subset untuk membatasi role.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={grantRole}
                    onChange={(e) => setGrantRole(e.target.value)}
                    className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm"
                  >
                    {roleIds.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                  <Button variant="primary" size="sm" onClick={saveRoleGrants} disabled={grantBusy}>
                    {grantBusy ? "Menyimpan…" : "Simpan akses"}
                  </Button>
                </div>
              </div>
              {grantDraft.length === 0 ? (
                <div className="mb-2 rounded-[var(--r-sm)] border border-[var(--success)]/30 bg-[var(--success-50)] px-2 py-1.5 text-[11px] text-[var(--success)]">
                  Mode unrestricted untuk <strong>{grantRole}</strong>: semua model enabled boleh dipakai.
                </div>
              ) : (
                <div className="mb-2 text-[11px] text-[var(--ink-3)]">
                  {grantDraft.length} model dipilih untuk <strong>{grantRole}</strong>
                </div>
              )}
              <div className="relative mb-2">
                <svg
                  viewBox="0 0 24 24"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-3)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={grantQuery}
                  onChange={(e) => setGrantQuery(e.target.value)}
                  placeholder="Cari model (label atau key)…"
                  className="w-full rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] py-1.5 pl-8 pr-2 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)] focus:border-[var(--magenta-300)] focus:bg-[var(--paper-3)] focus:ring-2 focus:ring-[var(--magenta-500)]/15"
                />
              </div>
              <div className="grid max-h-64 gap-1 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
                {models
                  .filter((m) => {
                    const q = grantQuery.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      m.label.toLowerCase().includes(q) ||
                      m.key.toLowerCase().includes(q)
                    );
                  })
                  .map((m) => (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-[var(--r-sm)] border px-2 py-1.5 text-xs ${
                      grantDraft.includes(m.key)
                        ? "border-[var(--magenta-200)] bg-[var(--magenta-50)]"
                        : "border-[var(--line)] bg-[var(--paper)]"
                    } ${!m.enabled ? "opacity-50" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={grantDraft.includes(m.key)}
                      onChange={() => toggleGrantKey(m.key)}
                      className="h-3.5 w-3.5 accent-[var(--magenta)]"
                    />
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-[var(--ink)]">{m.label}</span>
                      <code className="ml-1 text-[10px] text-[var(--ink-3)]">{m.key}</code>
                    </span>
                  </label>
                ))}
              </div>
              {grantDraft.length > 0 && (
                <button
                  type="button"
                  className="mt-2 text-[11px] text-[var(--ink-3)] underline hover:text-[var(--ink)]"
                  onClick={() => setGrantDraft([])}
                >
                  Clear → unrestricted
                </button>
              )}
            </Card>

            <div className="mt-6 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]/40 px-4 py-3 text-xs text-[var(--ink-3)]">
              <strong className="font-semibold text-[var(--ink-2)]">Catatan:</strong>{" "}
              <em>Import dari endpoint</em> memanggil <code>GET {"{LLM_BASE_URL}"}/models</code> dan
              menambahkan key baru (skip yang sudah ada). RBAC memfilter dropdown + menolak run
              model di luar grant. Session lama dengan model terlarang akan 403 saat kirim pesan.
            </div>
          </>
        )}
      </FullscreenOverlay>

      <ModelDialog value={modal} onClose={() => setModal(null)} onSubmit={saveModal} />
    </>
  );
}

function StatTile({
  label, value, tone,
}: {
  label: string;
  value: number;
  tone: "ink" | "success" | "danger";
}) {
  const toneClass = {
    ink: "bg-[var(--paper-2)] text-[var(--ink-2)] ring-[var(--line)]",
    success: "bg-[var(--success-50)] text-[var(--success)] ring-[#B6DCC4]",
    danger: "bg-[var(--danger-50)] text-[var(--danger)] ring-[#EFB5B5]",
  }[tone];
  return (
    <Card className={`flex items-center gap-3 p-3.5 ring-1 ring-inset ${toneClass}`}>
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em]">{label}</div>
      </div>
    </Card>
  );
}

function ModelCard({
  model, onEdit, onEnable, onDisable,
}: {
  model: Model;
  onEdit: () => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <Card className="card-hover relative flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--ink)]">
              {model.label}
            </h3>
            {model.enabled ? <Pill tone="success">enabled</Pill> : <Pill tone="danger">disabled</Pill>}
          </div>
          <code className="mt-1 inline-block rounded bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink-2)]">
            {model.key}
          </code>
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[var(--ink-3)]">
        <span>sort: {model.sort_order ?? 0}</span>
        {model.updated_at && (
          <>
            <span>·</span>
            <span>updated {new Date(model.updated_at).toLocaleDateString("id-ID")}</span>
          </>
        )}
      </div>
      <div className="flex gap-1 pt-1">
        <Button variant="ghost" size="sm" className="flex-1" onClick={onEdit}>Edit</Button>
        {model.enabled ? (
          <Button variant="ghost" size="sm" className="flex-1" onClick={onDisable}>
            <span className="text-[var(--danger)]">Disable</span>
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="flex-1" onClick={onEnable}>
            <span className="text-[var(--success)]">Enable</span>
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---- ModelDialog (create/edit form) --------------------------------------

function ModelDialog({
  value, onClose, onSubmit,
}: {
  value:
    | { kind: "create" }
    | { kind: "edit"; model: Model }
    | null;
  onClose: () => void;
  onSubmit: (payload: ModelPayload) => Promise<void>;
}) {
  const isEdit = !!value && value.kind === "edit";
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [sortOrder, setSortOrder] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) return;
    setError(null);
    if (value.kind === "edit") {
      setKey(value.model.key);
      setLabel(value.model.label);
      setEnabled(value.model.enabled !== false);
      setSortOrder(value.model.sort_order ?? 0);
    } else {
      setKey(""); setLabel(""); setEnabled(true); setSortOrder(0);
    }
  }, [value]);

  if (!value) return null;

  function validateKey(raw: string): string | null {
    if (!raw || !raw.trim()) return "Key wajib diisi";
    if (/\s/.test(raw)) return "Key tidak boleh mengandung spasi atau baris baru";
    return null;
  }

  async function save() {
    setError(null);
    if (!isEdit) {
      const err = validateKey(key);
      if (err) { setError(err); return; }
    }
    if (!label.trim()) {
      setError("Label wajib diisi");
      return;
    }
    const payload: ModelPayload = { label: label.trim() };
    if (!isEdit) {
      payload.key = key.trim();
      payload.enabled = enabled;
      payload.sort_order = sortOrder;
    } else {
      payload.enabled = enabled;
      payload.sort_order = sortOrder;
    }
    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (e: any) {
      setError(e?.message || "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={isEdit ? `Edit model: ${(value as any).model.label}` : "Tambah model"}
      description="Key dikirim ke backend engine via CLI flag. Bebas karakter apapun selama non-kosong dan tanpa spasi."
      widthClass="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "Menyimpan…" : isEdit ? "Simpan" : "Buat"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!isEdit && (
          <TextField
            label="Key (CLI flag)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="workspace atau provider/model-name"
            autoFocus
            hint="Karakter apapun kecuali spasi. Contoh: provider/model-name atau custom.id"
          />
        )}
        <TextField
          label="Label (tampil di dropdown)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Workspace"
        />
        <div className="flex items-center gap-4">
          <label className="flex flex-1 items-center gap-2 text-sm text-[var(--ink-2)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--magenta)]"
            />
            Enabled (muncul di dropdown)
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--ink-2)]">
            <span>Sort</span>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              min={0}
              max={10000}
              className="w-20 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-3)] px-2 py-1 text-sm focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
            />
          </label>
        </div>
        {error && (
          <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}