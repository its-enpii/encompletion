"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Card } from "@/components/ui/Card";
import { CenteredDialog } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import { FullscreenOverlay } from "@/components/ui/FullscreenOverlay";

/**
 * Users admin panel — surfaced as a fullscreen overlay from
 * AppShell via the "admin:open-users" window event. Body and CRUD
 * surface migrated from /(main)/users/page.tsx; auth/admin gate runs
 * inline so a non-admin who lands on this dialog sees a brief
 * explainer instead of an empty list.
 */

type User = {
  id: number;
  username: string;
  display_name: string | null;
  role: "admin" | "member";
  disabled: boolean;
  created_at: string;
  updated_at: string | null;
  last_login_at: string | null;
};

type ModalKind =
  | { kind: "create" }
  | { kind: "edit"; user: User; isSelf: boolean }
  | { kind: "reset"; user: User };

export function UsersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast } = useUi();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

  const [view, setView] = useState<"table" | "cards">("table");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "member">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");

  // Pagination. Backend hits `/api/users?limit=N&offset=M&q=...&sort=...
  // &dir=...` (see backend/src/routes/users.js). Total comes from
  // server so the page controls render the right counts without a
  // second roundtrip.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("limit", String(pageSize));
      qs.set("offset", String((page - 1) * pageSize));
      // Server-side search (case-insensitive LIKE on username +
      // display_name). Role/status filter stays FE-side because the
      // counts are tiny — keeps the SQL simple and the FE in sync
      // with the existing filter UX.
      if (search.trim()) qs.set("q", search.trim());
      const r = await authFetch(`/api/users?${qs.toString()}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setUsers(data.users || []);
      setTotal(typeof data.total === "number" ? data.total : 0);
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
    // Reset transient state on each open so a prior open's search/
    // filter/page doesn't bleed into a fresh open.
    setSearch("");
    setRoleFilter("all");
    setStatusFilter("all");
    setPage(1);
    setModal(null);
    setDeleteTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.role]);

  // Refetch when pageSize or page changes (debounced search is
  // handled via the explicit onChange handler below).
  useEffect(() => {
    if (!open || authLoading || me?.role !== "admin") return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  // Reset to page 1 when server-side search query changes so the user
  // doesn't land on an out-of-range page after narrowing results.
  useEffect(() => {
    if (!open) return;
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (statusFilter !== "all") {
        if (statusFilter === "active" && u.disabled) return false;
        if (statusFilter === "disabled" && !u.disabled) return false;
      }
      if (q) {
        const hay = `${u.username} ${u.display_name || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [users, search, roleFilter, statusFilter]);

  // Stats tiles. Total comes from the server (correct even when the
  // page slice is small). Admin/Active/Disabled are derived from the
  // current page — accurate enough for a header glance; if precision
  // ever matters we can issue a second COUNT query.
  const stats = useMemo(() => ({
    total,
    admins: users.filter((u) => u.role === "admin").length,
    active: users.filter((u) => !u.disabled).length,
    disabled: users.filter((u) => u.disabled).length,
  }), [users, total]);

  async function createUser(payload: any) {
    const r = await authFetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    setModal(null);
    load();
  }

  async function updateUser(id: number, payload: Partial<Pick<User, "role" | "display_name" | "disabled">>) {
    const r = await authFetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    setModal(null);
    load();
  }

  async function resetPassword(id: number, newPassword: string) {
    const r = await authFetch(`/api/users/${id}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_password: newPassword }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    setModal(null);
    load();
  }

  async function deleteUser(id: number) {
    const r = await authFetch(`/api/users/${id}`, { method: "DELETE" });
    if (!r.ok) {
      toast("Gagal menghapus user", "error");
      return;
    }
    load();
  }

  // Body extraction — the modal that renders the body is the
  // FullscreenOverlay; everything else renders inline. When the
  // dialog opens for a non-admin, we still render the chrome so
  // the user sees a "not authorized" pane rather than a flash of
  // nothing.
  const headerActions = me?.role === "admin" ? (
    <Button variant="primary" size="sm" onClick={() => setModal({ kind: "create" })}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <span>Add user</span>
    </Button>
  ) : null;

  return (
    <>
      <FullscreenOverlay
        open={open}
        onClose={onClose}
        title="User management"
        subtitle={
          authLoading
            ? "Memuat…"
            : me?.role !== "admin"
              ? "Hanya admin yang dapat melihat halaman ini."
              : "Kelola akun dan hak akses."
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
              Buka sebagai admin untuk mengelola user.
            </p>
          </Card>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Total users" value={stats.total} tone="ink" icon="users" />
              <StatTile label="Admins" value={stats.admins} tone="saffron" icon="shield" />
              <StatTile label="Active" value={stats.active} tone="success" icon="check" />
              <StatTile label="Disabled" value={stats.disabled} tone="danger" icon="lock" />
            </div>

            <Card className="mb-5 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-3)]" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Cari user…"
                    className="block w-full rounded-[var(--r-md)] border border-transparent bg-[var(--paper-2)] py-2 pl-9 pr-3 text-sm placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:bg-[var(--paper-3)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                  />
                </div>
                <PillsFilter label="Role" value={roleFilter} options={[
                  { value: "all", label: "All" },
                  { value: "admin", label: "Admin" },
                  { value: "member", label: "Member" },
                ]} onChange={setRoleFilter} />
                <PillsFilter label="Status" value={statusFilter} options={[
                  { value: "all", label: "All" },
                  { value: "active", label: "Active" },
                  { value: "disabled", label: "Disabled" },
                ]} onChange={setStatusFilter} />
                <div className="flex items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
                  <button
                    onClick={() => setView("table")}
                    className={`grid h-7 w-7 place-items-center rounded-[6px] transition-all ${
                      view === "table"
                        ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                        : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                    }`}
                    title="Table view"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setView("cards")}
                    className={`grid h-7 w-7 place-items-center rounded-[6px] transition-all ${
                      view === "cards"
                        ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                        : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                    }`}
                    title="Cards view"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                  </button>
                </div>
              </div>
            </Card>

            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
                <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {loading ? (
              <div className={view === "cards" ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : ""}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="card h-32 animate-pulse" />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <Card className="p-10 text-center">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--paper-2)] text-[var(--ink-3)]">
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <p className="mt-3 text-sm font-medium text-[var(--ink)]">
                  Tidak ada user yang cocok
                </p>
                <p className="mt-1 text-xs text-[var(--ink-3)]">
                  Coba ubah filter atau kata kunci pencarian.
                </p>
              </Card>
            ) : view === "table" ? (
              <Card className="overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--line)] bg-[var(--paper-2)] text-left text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
                      <th className="px-5 py-3 font-semibold">User</th>
                      <th className="px-5 py-3 font-semibold">Role</th>
                      <th className="px-5 py-3 font-semibold">Status</th>
                      <th className="hidden px-5 py-3 font-semibold md:table-cell">Last login</th>
                      <th className="hidden px-5 py-3 font-semibold md:table-cell">Created</th>
                      <th className="px-5 py-3 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((u, idx) => (
                      <tr
                        key={u.id}
                        className={`group border-b border-[var(--line)] transition-colors last:border-0 hover:bg-[var(--paper-2)]/50 ${idx % 2 === 1 ? "bg-[var(--paper-2)]/30" : ""}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className={`grid h-10 w-10 place-items-center rounded-full text-xs font-semibold shadow-[var(--shadow-1)] ring-2 ring-[var(--paper-3)] ${
                              u.role === "admin"
                                ? "bg-gradient-to-br from-[var(--saffron-200)] to-[var(--saffron-500)] text-[var(--ink)]"
                                : "bg-gradient-to-br from-[var(--magenta-400)] to-[var(--magenta-700)] text-white"
                            }`}>
                              {(u.display_name || u.username).slice(0, 2).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-[var(--ink)]">
                                {u.display_name || u.username}
                              </div>
                              <div className="truncate text-[11px] text-[var(--ink-3)]">@{u.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <Pill tone={u.role === "admin" ? "saffron" : "neutral"}>{u.role}</Pill>
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 rounded-full ${u.disabled ? "bg-[var(--danger)]" : "bg-[var(--success)]"}`} />
                            {u.disabled ? <Pill tone="danger">disabled</Pill> : <Pill tone="success">active</Pill>}
                          </div>
                        </td>
                        <td className="hidden px-5 py-3.5 text-xs text-[var(--ink-3)] md:table-cell">
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleString("id-ID") : <span className="italic">never</span>}
                        </td>
                        <td className="hidden px-5 py-3.5 text-xs text-[var(--ink-3)] md:table-cell">
                          {new Date(u.created_at).toLocaleDateString("id-ID")}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex justify-end gap-1 text-xs">
                            <Button variant="ghost" size="sm" onClick={() => setModal({ kind: "edit", user: u, isSelf: u.id === me.id })}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setModal({ kind: "reset", user: u })}>
                              Reset
                            </Button>
                            {u.id !== me.id && (
                              <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(u)}>
                                <span className="text-[var(--danger)]">Delete</span>
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((u) => (
                  <UserCard
                    key={u.id}
                    user={u}
                    isSelf={u.id === me.id}
                    onEdit={() => setModal({ kind: "edit", user: u, isSelf: u.id === me.id })}
                    onReset={() => setModal({ kind: "reset", user: u })}
                    onDelete={() => setDeleteTarget(u)}
                  />
                ))}
              </div>
            )}
            <PaginationFooter
              total={total}
              page={page}
              pageSize={pageSize}
              visibleCount={visible.length}
              onPageChange={(p) => setPage(p)}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
            />
          </>
        )}
      </FullscreenOverlay>

      <UserDialog
        value={modal}
        onClose={() => setModal(null)}
        onSubmit={async (payload) => {
          if (!modal) return;
          if (modal.kind === "create") await createUser(payload);
          else if (modal.kind === "edit") await updateUser(modal.user.id, payload as Partial<Pick<User, "role" | "display_name" | "disabled">>);
          else if (modal.kind === "reset") await resetPassword(modal.user.id, payload as string);
        }}
      />

      {deleteTarget && (
        <DeleteUserDialog
          open
          username={deleteTarget.username}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deleteUser(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
      )}
    </>
  );
}

// ---- Inline helpers (form components + cards) -----------------------------

function PaginationFooter({
  total, page, pageSize, visibleCount, onPageChange, onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  visibleCount: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = total === 0 ? 0 : start + visibleCount - 1;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]/60 px-3 py-2 text-xs text-[var(--ink-2)]">
      <div>
        Showing <span className="font-semibold tabular-nums text-[var(--ink)]">{start}–{end}</span> of <span className="font-semibold tabular-nums text-[var(--ink)]">{total}</span>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span>Per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="rounded-[6px] border border-[var(--line)] bg-[var(--paper)] px-1.5 py-0.5 text-xs"
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--paper)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="grid h-6 w-6 place-items-center rounded-[5px] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="px-2 font-mono text-[11px] tabular-nums">Page {page} / {totalPages}</span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
            className="grid h-6 w-6 place-items-center rounded-[5px] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label, value, tone, icon,
}: {
  label: string;
  value: number;
  tone: "ink" | "saffron" | "success" | "danger";
  icon: "users" | "shield" | "check" | "lock";
}) {
  const toneClass = {
    ink: "bg-[var(--paper-2)] text-[var(--ink-2)] ring-[var(--line)]",
    saffron: "bg-[var(--saffron-50)] text-[var(--saffron-500)] ring-[#F2C887]",
    success: "bg-[var(--success-50)] text-[var(--success)] ring-[#B6DCC4]",
    danger: "bg-[var(--danger-50)] text-[var(--danger)] ring-[#EFB5B5]",
  }[tone];

  return (
    <Card className={`flex items-center gap-3 p-3.5 ring-1 ring-inset ${toneClass}`}>
      <span className="grid h-10 w-10 place-items-center rounded-[var(--r-md)] bg-[var(--paper-3)] ring-1 ring-inset ring-[var(--line)]">
        <StatIcon name={icon} className="h-4 w-4" />
      </span>
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">{label}</div>
      </div>
    </Card>
  );
}

function StatIcon({ name, ...props }: { name: "users" | "shield" | "check" | "lock" } & React.SVGProps<SVGSVGElement>) {
  if (name === "users") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>;
  if (name === "shield") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="20 6 9 17 4 12" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
}

function PillsFilter<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="label mr-1 hidden sm:block">{label}</span>
      <div className="flex items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-[6px] px-2.5 py-1 text-[11px] font-medium transition-all ${
              value === o.value
                ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserCard({
  user, isSelf, onEdit, onReset, onDelete,
}: {
  user: User;
  isSelf: boolean;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const isAdmin = user.role === "admin";
  return (
    <Card className="card-hover relative flex flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <span className={`grid h-12 w-12 place-items-center rounded-full text-sm font-semibold shadow-[var(--shadow-2)] ring-2 ring-[var(--paper-3)] ${
          isAdmin
            ? "bg-gradient-to-br from-[var(--saffron-200)] to-[var(--saffron-500)] text-[var(--ink)]"
            : "bg-gradient-to-br from-[var(--magenta-400)] to-[var(--magenta-700)] text-white"
        }`}>
          {(user.display_name || user.username).slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-[var(--ink)]">
              {user.display_name || user.username}
            </h3>
            {isSelf && <Pill tone="info">you</Pill>}
          </div>
          <div className="truncate text-xs text-[var(--ink-3)]">@{user.username}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={isAdmin ? "saffron" : "neutral"}>{user.role}</Pill>
        {user.disabled ? <Pill tone="danger">disabled</Pill> : <Pill tone="success">active</Pill>}
      </div>
      <div className="space-y-1 border-t border-[var(--line)] pt-3 text-xs text-[var(--ink-3)]">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Last login {user.last_login_at ? new Date(user.last_login_at).toLocaleString("id-ID") : <em>never</em>}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>Created {new Date(user.created_at).toLocaleDateString("id-ID")}</span>
        </div>
      </div>
      <div className="flex gap-1 pt-1">
        <Button variant="ghost" size="sm" className="flex-1" onClick={onEdit}>Edit</Button>
        <Button variant="ghost" size="sm" className="flex-1" onClick={onReset}>Reset</Button>
        {!isSelf && (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <span className="text-[var(--danger)]">Delete</span>
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---- UserDialog (create/edit/reset forms) --------------------------------

function UserDialog({
  value, onClose, onSubmit,
}: {
  value: ModalKind | null;
  onClose: () => void;
  onSubmit: (payload: unknown) => Promise<void>;
}) {
  if (!value) return null;

  return (
    <CenteredDialog
      open
      onClose={onClose}
      title={
        value.kind === "create" ? "Tambah user"
          : value.kind === "edit" ? `Edit: ${value.user.username}`
          : `Reset password: ${value.user.username}`
      }
      widthClass="max-w-md"
    >
      {value.kind === "create" && <CreateForm onCancel={onClose} onSubmit={onSubmit} />}
      {value.kind === "edit" && <EditForm user={value.user} isSelf={value.isSelf} onCancel={onClose} onSubmit={onSubmit} />}
      {value.kind === "reset" && <ResetForm user={value.user} onCancel={onClose} onSubmit={onSubmit} />}
    </CenteredDialog>
  );
}

function CreateForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (payload: unknown) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ username, display_name: displayName, password, role });
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      <TextField label="Display name (opsional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <TextField label="Password (min 6)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div>
        <label className="label mb-1.5 block">Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")} className="input">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Batal</Button>
        <Button variant="primary" type="submit" disabled={busy || !username.trim() || password.length < 6}>
          {busy ? "Membuat…" : "Buat"}
        </Button>
      </div>
    </form>
  );
}

function EditForm({ user, isSelf, onCancel, onSubmit }: { user: User; isSelf: boolean; onCancel: () => void; onSubmit: (payload: unknown) => Promise<void> }) {
  const [displayName, setDisplayName] = useState(user.display_name || "");
  const [role, setRole] = useState<"admin" | "member">(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ role, display_name: displayName, disabled });
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <TextField label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <div>
        <label className="label mb-1.5 block">Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")} disabled={isSelf} className="input">
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        {isSelf && <p className="mt-1 text-xs text-[var(--ink-3)]">Tidak bisa ubah role sendiri.</p>}
      </div>
      <label className="flex items-center gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5 text-sm">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} disabled={isSelf}
          className="h-4 w-4 rounded border-[var(--line-strong)] bg-[var(--paper-3)] accent-[var(--magenta)]" />
        <span className="text-[var(--ink-2)]">Disabled (tidak bisa login)</span>
      </label>
      {isSelf && <p className="text-xs text-[var(--ink-3)]">Tidak bisa disable akun sendiri.</p>}
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Batal</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan"}
        </Button>
      </div>
    </form>
  );
}

function ResetForm({ user, onCancel, onSubmit }: { user: User; onCancel: () => void; onSubmit: (payload: unknown) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (password.length < 6) return setErr("Password minimal 6 karakter");
    if (password !== confirm) return setErr("Password tidak sama");
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(password);
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <TextField label="Password baru (min 6)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <TextField label="Konfirmasi" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Batal</Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Reset"}
        </Button>
      </div>
    </form>
  );
}

// ---- DeleteUserDialog ----------------------------------------------------

function DeleteUserDialog({
  open, username, onClose, onConfirm,
}: {
  open: boolean;
  username: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Gagal menghapus");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Hapus user?"
      description={`Tindakan ini permanen — user "${username}" tidak akan bisa login lagi.`}
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button variant="danger" onClick={doDelete} disabled={busy}>
            {busy ? "Menghapus…" : "Hapus permanen"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      <p className="text-sm text-[var(--ink-2)]">
        Karena hapus user bisa berakibat pada orphaned sessions, mohon konfirmasi dengan teliti.
      </p>
    </CenteredDialog>
  );
}