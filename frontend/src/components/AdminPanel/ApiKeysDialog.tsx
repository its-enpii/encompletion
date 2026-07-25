"use client";

import { useEffect, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CenteredDialog } from "@/components/ui/Modal";
import {
  ApiKey, CreatedApiKey, copyToClipboard, createApiKey, deleteApiKey, listApiKeys,
} from "@/lib/api-keys";

type Model = { key: string; label: string };

/**
 * API key management — surfaced as a centered modal. Compact enough
 * (max-w-2xl) for the create form + list, doesn't need fullscreen.
 * Used by every authenticated user (not admin-gated) since users
 * manage their own keys.
 */
export function ApiKeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm } = useUi();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [k, m] = await Promise.all([
        listApiKeys(),
        authFetch("/api/models?enabled_only=1").then((r) => (r.ok ? r.json() : [])),
      ]);
      setKeys(k);
      const enabled = (m as any[]).map((row) => ({ key: row.key, label: row.label }));
      setModels(enabled);
      if (!model && enabled.length > 0) setModel(enabled[0].key);
    } catch (e: any) {
      setError(e.message || "failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (authLoading || !me) return;
    load();
    // Reset transient state on each open.
    setName("");
    setJustCreated(null);
    setCopied(false);
    setModel("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.id]);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !model) {
      toast("Nama dan model wajib diisi", "error");
      return;
    }
    setCreating(true);
    try {
      const k = await createApiKey(name.trim(), model);
      setJustCreated(k);
      setName("");
      setCopied(false);
      await load();
    } catch (e: any) {
      toast(e.message || "Gagal membuat key", "error");
    } finally {
      setCreating(false);
    }
  }

  async function copy() {
    if (!justCreated) return;
    const ok = await copyToClipboard(justCreated.plaintext);
    setCopied(ok);
    if (ok) toast("Key disalin ke clipboard", "success");
    else toast("Gagal menyalin — pilih manual lalu salin", "error");
  }

  async function revoke(k: ApiKey) {
    const ok = await confirm({
      title: "Cabut API key",
      message: `Key "${k.name}" akan langsung tidak bisa dipakai. Lanjutkan?`,
      confirmLabel: "Cabut",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteApiKey(k.id);
      await load();
      toast("Key dicabut", "success");
    } catch (e: any) {
      toast(e.message || "Gagal mencabut", "error");
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="API Keys"
      description={
        <span>
          Buat kunci untuk akses OpenAPI di{" "}
          <code className="rounded bg-[var(--paper-3)] px-1.5 py-0.5 text-[var(--ink-2)]">/api/v1</code>.
          Setiap key dikunci ke satu model — tidak bisa diganti via request body.
        </span>
      }
      widthClass="max-w-2xl"
    >
      {authLoading ? (
        <div className="grid place-items-center py-12 text-sm text-[var(--ink-3)]">
          <div className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--magenta)]" />
            Memuat…
          </div>
        </div>
      ) : !me ? (
        <p className="py-8 text-center text-sm text-[var(--ink-3)]">Silakan login dulu.</p>
      ) : (
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--ink-3)]">
              Buat baru
            </h2>
            <form onSubmit={submitCreate} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--ink-2)]">
                Nama
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. curl-test"
                  maxLength={64}
                  className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--ink-2)]">
                Model
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                >
                  {models.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label} ({m.key})
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="primary" disabled={creating || !name.trim() || !model}>
                {creating ? "Membuat…" : "Buat key"}
              </Button>
            </form>
          </Card>

          {justCreated && (
            <Card className="border-[var(--saffron-200)] bg-[var(--saffron-50)] p-4">
              <h2 className="text-sm font-semibold text-[var(--saffron-700)]">
                Key baru — salin sekarang
              </h2>
              <p className="mt-1 text-xs text-[var(--ink-2)]">
                Plaintext hanya ditampilkan sekali. Server hanya menyimpan hash-nya.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <code className="block max-w-full overflow-x-auto whitespace-pre rounded-[var(--r-md)] bg-[var(--paper)] px-3 py-2 font-mono text-xs text-[var(--ink)]">
                  {justCreated.plaintext}
                </code>
                <Button variant="primary" size="sm" onClick={copy}>
                  {copied ? "Tersalin ✓" : "Salin"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>
                  Tutup
                </Button>
              </div>
              <p className="mt-3 text-xs text-[var(--ink-3)]">
                Pakai sebagai <code>Authorization: Bearer {justCreated.prefix}</code> atau query
                <code> ?key=…</code> untuk EventSource.
              </p>
            </Card>
          )}

          <Card>
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink-3)]">
                Key aktif
              </h2>
              <span className="text-xs text-[var(--ink-3)]">
                {keys.length} key{keys.length === 1 ? "" : "s"}
              </span>
            </div>
            {loading ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--ink-3)]">Memuat…</div>
            ) : error ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--danger)]">{error}</div>
            ) : keys.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--ink-3)]">
                Belum ada key. Buat yang pertama di atas.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {keys.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--ink)]">{k.name}</span>
                        <span className="rounded-full bg-[var(--paper-3)] px-2 py-0.5 font-mono text-[10px] text-[var(--ink-3)]">
                          {k.model}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                        Dibuat {formatDate(k.created_at)}
                        {k.last_used_at ? ` · terakhir dipakai ${formatDate(k.last_used_at)}` : " · belum pernah dipakai"}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => revoke(k)}>
                      Cabut
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </CenteredDialog>
  );
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}