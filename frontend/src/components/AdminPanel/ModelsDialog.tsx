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

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/models?all=1");
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setModels(await r.json());
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

  const headerActions = me?.role === "admin" ? (
    <Button variant="primary" size="sm" onClick={() => setModal({ kind: "create" })}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <span>Tambah model</span>
    </Button>
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

            <div className="mt-6 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]/40 px-4 py-3 text-xs text-[var(--ink-3)]">
              <strong className="font-semibold text-[var(--ink-2)]">Catatan:</strong> perubahan di sini langsung terlihat di dropdown chat semua user (via broadcast socket). Session lama yang mereferensikan model yang dinonaktifkan masih bisa dibuka kembali untuk dilihat — saat mengirim pesan baru, sistem tetap memakai key yang tersimpan.
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