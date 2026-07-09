"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { ModelDialog, type Model, type ModelPayload } from "./ModelDialog";

export default function ModelsPage() {
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
      // Admin view: include disabled rows + full metadata.
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
    if (!authLoading && me?.role === "admin") load();
  }, [authLoading, me?.role]);

  const stats = useMemo(() => ({
    total: models.length,
    enabled: models.filter((m) => m.enabled).length,
    disabled: models.filter((m) => !m.enabled).length,
  }), [models]);

  if (authLoading) {
    return (
      <AppShell>
        <div className="grid flex-1 place-items-center text-sm text-[var(--ink-3)]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--magenta)]" />
            Memuat…
          </div>
        </div>
      </AppShell>
    );
  }
  if (!me) {
    return (
      <AppShell>
        <div className="p-6 text-sm text-[var(--ink-3)]">
          Silakan <Link href="/login" className="font-medium text-[var(--magenta-600)] underline">login</Link> dulu.
        </div>
      </AppShell>
    );
  }
  if (me.role !== "admin") {
    return (
      <AppShell>
        <div className="mx-auto max-w-md p-10 text-center">
          <h1 className="text-lg font-semibold text-[var(--ink)]">403 — Admin only</h1>
          <p className="mt-2 text-sm text-[var(--ink-3)]">
            Halaman ini hanya untuk admin.
          </p>
        </div>
      </AppShell>
    );
  }

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
    // ModelsProvider also listens on `models:updated` so other tabs sync.
  }

  async function disable(m: Model) {
    if (stats.enabled <= 1) {
      toast("Tidak bisa menonaktifkan model terakhir", "error");
      return;
    }
    const ok = await confirmDisable();
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
  }

  async function confirmDisable() {
    return confirm({
      title: "Nonaktifkan model",
      message: "Model ini akan hilang dari pilihan chat. Data historis tetap ada.",
      confirmLabel: "Nonaktifkan",
      destructive: true,
    });
  }

  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="mb-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--saffron-500)]">
                  <span className="h-px w-6 bg-[var(--saffron-500)]" />
                  Admin
                </div>
                <h1 className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
                  Model registry
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--ink-3)]">
                  Kelola model yang tersedia di dropdown chat. Tambah key baru (lowercase-kebab), atur label, urutan, dan aktif/nonaktif.
                  Daftar ini hanya memfilter apa yang dikirim lewat <code className="rounded bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[11px]">--model</code> ke backend — tidak ada panggilan keluar sendiri.
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={() => setModal({ kind: "create" })}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Tambah model</span>
              </Button>
            </div>
          </div>

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
              <p className="text-sm font-medium text-[var(--ink)]">
                Belum ada model
              </p>
              <p className="mt-1 text-xs text-[var(--ink-3)]">
                Tambah model pertama untuk mulai.
              </p>
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
            <strong className="font-semibold text-[var(--ink-2)]">Catatan:</strong> perubahan di sini langsung terlihat di dropdown chat semua user (via broadcast socket). Session lama yang mereferensikan model yang dinonaktifkan masih bisa dibuka kembali untuk dilihat — saat Anda mengirim pesan baru dari session itu, sistem akan tetap memakai key yang tersimpan. Ganti key di session lewat regenerate jika perlu.
          </div>
        </div>
      </div>

      <ModelDialog
        value={modal}
        onClose={() => setModal(null)}
        onSubmit={saveModal}
      />
    </AppShell>
  );
}

function ModelCard({
  model,
  onEdit,
  onEnable,
  onDisable,
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
            {model.enabled ? (
              <Pill tone="success">enabled</Pill>
            ) : (
              <Pill tone="danger">disabled</Pill>
            )}
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
        <Button variant="ghost" size="sm" className="flex-1" onClick={onEdit}>
          Edit
        </Button>
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

function StatTile({
  label,
  value,
  tone,
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
