"use client";

import { useEffect, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { TextField } from "@/components/ui/TextField";
import { CenteredDialog } from "@/components/ui/Modal";
import { FullscreenOverlay } from "@/components/ui/FullscreenOverlay";

type Role = {
  id: string;
  label: string;
  is_system: boolean;
  sort_order: number;
  user_count: number;
  created_at?: string | null;
};

/**
 * Roles admin — CRUD for assignment + model-RBAC slugs.
 * Platform powers stay on literal `admin` only; custom roles are
 * non-admin identities that can hold their own model grants.
 */
export function RolesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm } = useUi();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Role | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/roles");
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setRoles(Array.isArray(data.roles) ? data.roles : []);
    } catch (e: any) {
      setError(e?.message || "Gagal memuat roles");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    if (authLoading || me?.role !== "admin") return;
    load();
    setCreateOpen(false);
    setEditTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.role]);

  async function createRole(payload: { id: string; label: string }) {
    const r = await authFetch("/api/roles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    toast(`Role ${payload.id} dibuat`, "success");
    setCreateOpen(false);
    await load();
  }

  async function renameRole(id: string, label: string) {
    const r = await authFetch(`/api/roles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    toast("Label disimpan", "success");
    setEditTarget(null);
    await load();
  }

  async function deleteRole(role: Role) {
    if (role.is_system) return;
    const ok = await confirm({
      title: `Hapus role “${role.id}”?`,
      message:
        role.user_count > 0
          ? `Masih dipakai ${role.user_count} user. Reassign dulu.`
          : "Grant model untuk role ini ikut terhapus.",
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    if (role.user_count > 0) {
      toast("Reassign user dulu sebelum hapus role", "error");
      return;
    }
    const r = await authFetch(`/api/roles/${encodeURIComponent(role.id)}`, {
      method: "DELETE",
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(d.error || "Gagal menghapus", "error");
      return;
    }
    toast(`Role ${role.id} dihapus`, "success");
    await load();
  }

  const headerActions =
    me?.role === "admin" ? (
      <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>Role baru</span>
      </Button>
    ) : null;

  return (
    <>
      <FullscreenOverlay
        open={open}
        onClose={onClose}
        title="Roles"
        subtitle={
          authLoading
            ? "Memuat…"
            : me?.role !== "admin"
              ? "Hanya admin yang dapat melihat halaman ini."
              : "Slug role untuk assign user + grant model. Platform power tetap di role admin saja."
        }
        headerActions={headerActions}
      >
        {authLoading ? (
          <div className="grid place-items-center py-20 text-sm text-[var(--ink-3)]">Memuat…</div>
        ) : me?.role !== "admin" ? (
          <Card className="p-10 text-center">
            <h2 className="text-base font-semibold text-[var(--ink)]">403 — Admin only</h2>
          </Card>
        ) : (
          <>
            {error && (
              <div className="mb-4 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
                {error}
              </div>
            )}
            {loading ? (
              <div className="grid gap-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="card h-14 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--line)]">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[var(--paper-2)] text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
                    <tr>
                      <th className="px-3 py-2">Slug</th>
                      <th className="px-3 py-2">Label</th>
                      <th className="px-3 py-2">Users</th>
                      <th className="px-3 py-2">Tipe</th>
                      <th className="px-3 py-2 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id} className="border-t border-[var(--line)]">
                        <td className="px-3 py-2 font-mono text-xs text-[var(--ink)]">{role.id}</td>
                        <td className="px-3 py-2 text-[var(--ink-2)]">{role.label}</td>
                        <td className="px-3 py-2 tabular-nums text-[var(--ink-2)]">{role.user_count}</td>
                        <td className="px-3 py-2">
                          <Pill tone={role.is_system ? "saffron" : "neutral"}>
                            {role.is_system ? "system" : "custom"}
                          </Pill>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setEditTarget(role)}>
                              Rename
                            </Button>
                            {!role.is_system && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => deleteRole(role)}
                                disabled={role.user_count > 0}
                              >
                                Hapus
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs text-[var(--ink-3)]">
              Grant model per role di panel Models → RBAC. User di-assign role lewat Users.
            </p>
          </>
        )}
      </FullscreenOverlay>

      <CenteredDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Role baru"
        description="Slug dipakai di users.role dan role_models. Huruf kecil, angka, _ dan -."
      >
        <CreateRoleForm onCancel={() => setCreateOpen(false)} onSubmit={createRole} />
      </CenteredDialog>

      <CenteredDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={editTarget ? `Rename “${editTarget.id}”` : "Rename"}
      >
        {editTarget && (
          <RenameRoleForm
            role={editTarget}
            onCancel={() => setEditTarget(null)}
            onSubmit={(label) => renameRole(editTarget.id, label)}
          />
        )}
      </CenteredDialog>
    </>
  );
}

function CreateRoleForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (p: { id: string; label: string }) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ id: id.trim().toLowerCase(), label: label.trim() || id.trim() });
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <TextField
        label="Slug (id)"
        value={id}
        onChange={(e) => setId(e.target.value.toLowerCase())}
        placeholder="slug-role"
        autoFocus
      />
      <TextField
        label="Label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Nama tampilan (opsional)"
      />
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Batal
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !id.trim()}>
          {busy ? "Membuat…" : "Buat"}
        </Button>
      </div>
    </form>
  );
}

function RenameRoleForm({
  role,
  onCancel,
  onSubmit,
}: {
  role: Role;
  onCancel: () => void;
  onSubmit: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(role.label);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(label.trim());
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <TextField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Batal
        </Button>
        <Button variant="primary" type="submit" disabled={busy || !label.trim()}>
          {busy ? "Menyimpan…" : "Simpan"}
        </Button>
      </div>
    </form>
  );
}
