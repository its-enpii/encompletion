"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Brand } from "./Brand";
import { SessionRow } from "./SessionRow";
import { SessionSearchDialog } from "./SessionSearchDialog";
import { UserMenu } from "./UserMenu";
import type { Session } from "./types";

export type { Session, Project } from "./types";

const ADMIN_NAV: { href: string; icon: "users" | "cpu"; label: string }[] = [
  { href: "/users", icon: "users", label: "Users" },
  { href: "/models", icon: "cpu", label: "Models" },
];

type Props = {
  activeSessionId: number | null;
  onSelectSession: (s: Session) => void;
  onNewChat: () => void;
  refreshKey?: number;
  open?: boolean;
  onClose?: () => void;
  /**
   * Desktop layout mode for the sidebar. On mobile this is forced to "drawer":
   * the sidebar is fixed and slides in/out, controlled by `open` + `onClose`.
   * On `md+` viewports:
   *  - "full"   : 280px wide, always visible
   *  - "mini"   : ~64px icon rail, always visible (text labels collapse)
   *  - "hidden" : not rendered; chat header shows a "show sidebar" toggle
   */
  mode?: "full" | "mini" | "hidden";
  onCycleMode?: () => void;
};

type FilterMode = "all" | "starred";

export default function Sidebar({
  activeSessionId,
  onSelectSession,
  onNewChat,
  refreshKey = 0,
  open = false,
  onClose,
  mode = "full",
  onCycleMode,
}: Props) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { toast, confirm, prompt } = useUi();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"recent" | "today" | "older">("recent");
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [projects, setProjects] = useState<import("./types").Project[]>([]);

  // Load projects so the search dialog can label hits by project color/name.
  useEffect(() => {
    authFetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => {});
  }, []);

  async function load() {
    try {
      const data = await authFetch("/api/sessions").then((r) => r.json());
      setSessions(data);
    } catch {
      /* silent: sidebar shouldn't block UI */
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshKey]);

  // Route scope.
  const projectMatch = pathname?.match(/^\/projects\/(\d+)/);
  const currentProjectId = projectMatch ? Number(projectMatch[1]) : null;
  const isProjectsIndex = pathname === "/projects";
  const isUsersIndex = pathname === "/users";
  const isModelsIndex = pathname === "/models";
  const isAdminRoute = isProjectsIndex || isUsersIndex || isModelsIndex;

  const scoped: Session[] = currentProjectId
    ? sessions.filter((s) => s.project_id === currentProjectId)
    : isAdminRoute
      ? []
      : sessions.filter((s) => s.project_id == null);

  // Filtering + grouping.
  const { grouped, totalCount, starredCount, starredList } = useMemo(() => {
    const total = scoped.length;
    // Normalize starred to a strict boolean — backend may return 0/1 ints,
    // JSON.parse may yield numbers, optimistic toggle may set 0/1. Treat any
    // truthy value as starred.
    const isStarred = (s: Session) => Boolean(s.starred);
    const starredAll = scoped.filter(isStarred);

    // Starred sessions get their own section pinned at the top, so we hide
    // them from the chronological groups below to avoid showing the same
    // session twice. (User feedback: starred row appearing in both Starred
    // and Today felt redundant.)
    let arr = scoped.filter((s) => !isStarred(s));
    if (filter === "starred") arr = starredAll;
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((s) =>
        (s.title || `session #${s.id}`).toLowerCase().includes(q)
      );
    }

    arr = [...arr].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );

    const now = Date.now();
    const dayMs = 24 * 3.6e6;
    const today = arr.filter((s) => now - new Date(s.updated_at).getTime() < dayMs);
    const thisWeek = arr.filter((s) => {
      const t = now - new Date(s.updated_at).getTime();
      return t >= dayMs && t < 7 * dayMs;
    });
    const older = arr.filter((s) => now - new Date(s.updated_at).getTime() >= 7 * dayMs);

    // Starred list — always computed independently of the active filter so
    // it can render its own section at the top of the list. Same search query
    // applies so typing in the search box narrows starred matches too.
    const q2 = search.trim().toLowerCase();
    const starredList = starredAll
      .filter((s) =>
        !q2 ? true : (s.title || `session #${s.id}`).toLowerCase().includes(q2)
      )
      .sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

    return {
      grouped: { today, thisWeek, older },
      totalCount: total,
      starredCount: starredAll.length,
      starredList,
    };
  }, [scoped, filter, search]);

  async function toggleStar(id: number) {
    setSessions((cur) =>
      cur.map((s) => (s.id === id ? { ...s, starred: s.starred ? 0 : 1 } : s))
    );
    try {
      const r = await authFetch(`/api/sessions/${id}/star`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      setSessions((cur) =>
        cur.map((s) => (s.id === id ? { ...s, starred: s.starred ? 0 : 1 } : s))
      );
      toast("Gagal update star", "error");
    }
  }

  async function startRename(s: Session) {
    const next = await prompt({
      title: "Rename session",
      message: "Masukkan judul baru untuk session ini.",
      initialValue: s.title || `Session #${s.id}`,
      placeholder: "judul session…",
      confirmLabel: "Rename",
      validate: (v) => (v ? undefined : "Judul tidak boleh kosong"),
    });
    if (next == null || next === s.title) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setSessions((cur) =>
      cur.map((row) => (row.id === s.id ? { ...row, title: trimmed } : row))
    );
    try {
      const r = await authFetch(`/api/sessions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      toast("Gagal rename session", "error");
      load();
    }
  }

  async function deleteSession(id: number) {
    const ok = await confirm({
      title: "Hapus session",
      message: "Session ini akan dihapus permanen. Lanjutkan?",
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    const prior = sessions;
    setSessions((cur) => cur.filter((s) => s.id !== id));
    try {
      const r = await authFetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      toast("Gagal hapus session", "error");
      setSessions(prior);
    }
  }

  function gotoNewChat() {
    if (currentProjectId != null) {
      router.push(`/projects/${currentProjectId}`);
    } else {
      onNewChat();
    }
  }

  const hasAny = grouped.today.length + grouped.thisWeek.length + grouped.older.length > 0;

  // `mode` is a desktop concept. On mobile, the rail is always rendered as
  // "full" (full label visibility, 280px width, no mini-icon-rail collapse)
  // because mobile has horizontal pressure but no horizontal room for the
  // compact rail. Inner content components (NavLink, BrandMark, UserMenu)
  // gate their collapsed appearance on the `md:` breakpoint via the
  // `mdCollapsed` prop below — a mobile render NEVER collapses labels
  // even if the persisted mode is "mini".
  const isMini = mode === "mini";
  const isHidden = mode === "hidden";

  return (
    <>
      {/* Mobile backdrop: shown when the drawer is fully open. Clicking it
          dispatches the "hidden" cycle event via the global open-sidebar
          inverse. Kept lightweight — we just toggle a local mobile flag. */}
      {open && (
        <div
          className="anim-fade-in fixed inset-0 z-30 bg-[#1A1410]/40 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        data-sidebar-mode={mode}
        // Width: mobile is locked to 280px (drawer). Desktop is driven by
        // the CSS variable so the `width` property transition animates
        // full↔mini. The `w-[280px] md:w-[var(--sb-w)]` ordering means
        // mobile ALWAYS uses 280px regardless of the persisted mode.
        style={
          isMini
            ? ({ "--sb-w": "64px" } as React.CSSProperties)
            : ({ "--sb-w": "280px" } as React.CSSProperties)
        }
        className={`fixed inset-y-0 left-0 z-40 flex min-w-0 flex-col border-r border-[var(--line-dark)] bg-[var(--dark)] text-[var(--dark-text)] shadow-[var(--shadow-3)] transition-all duration-300 ease-out md:sticky md:top-0 md:h-screen md:translate-x-0 w-[280px] md:w-[var(--sb-w)] ${
          // Mobile drawer: open → translate-x-0, closed → -translate-x-full
          open
            ? "translate-x-0"
            : "-translate-x-full"
        } ${
          // Desktop only: hidden mode slides the rail off-screen. The
          // `md:` prefix keeps the mobile state independent of `mode` —
          // the rail is hidden on mobile purely via the drawer translate.
          isHidden
            ? "md:-translate-x-full md:opacity-0 md:pointer-events-none md:shadow-none"
            : "md:translate-x-0 md:opacity-100"
        }`}
      >
        <Brand
          onCloseMobile={onClose}
          onCycleMode={onCycleMode}
          mode={mode}
        />

        {/* Primary nav — card-like container for visual rhythm */}
        <div className={`px-3 pb-3 ${isMini ? "md:px-2" : ""}`}>
          <div className="flex flex-col gap-0.5 rounded-[var(--r-lg)] bg-[var(--dark-2)]/60 p-1.5 ring-1 ring-inset ring-[var(--line-dark)]">
            <NavLink href="/new" icon="home" label="Home" current={pathname === "/new"} onClick={onClose} collapsed={isMini} />
            <NavLink href="/projects" icon="folder" label="Projects" current={pathname?.startsWith("/projects")} onClick={onClose} collapsed={isMini} />
            {user?.role === "admin" && (
              <>
                <NavLink href="/users" icon="users" label="Users" current={pathname === "/users"} onClick={onClose} collapsed={isMini} />
                <NavLink href="/models" icon="cpu" label="Models" current={pathname === "/models"} onClick={onClose} collapsed={isMini} />
              </>
            )}
          </div>
        </div>

        {/* CTA — prominent, with shimmer hint */}
        <div className={`px-3 pb-4 ${isMini ? "md:px-2" : ""}`}>
          <button
            type="button"
            onClick={gotoNewChat}
            title={isMini ? "New chat (N)" : undefined}
            aria-label="New chat"
            className={`group relative flex w-full items-center overflow-hidden rounded-[var(--r-md)] bg-gradient-to-br from-[var(--magenta-400)] to-[var(--magenta-700)] text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_2px_8px_rgba(168,71,129,0.30)] transition-all hover:from-[var(--magenta-300)] hover:to-[var(--magenta-600)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_4px_14px_rgba(168,71,129,0.40)] active:scale-[0.99] ${
              isMini ? "md:justify-center md:px-0 md:py-2.5" : "justify-center gap-2 px-4 py-2.5"
            }`}
          >
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className={isMini ? "md:hidden" : ""}>New chat</span>
            <kbd className={`kbd ml-auto !bg-white/15 !border-white/20 !text-white/90 ${isMini ? "md:hidden" : ""}`}>
              N
            </kbd>
          </button>
        </div>

        {!isAdminRoute && !isMini && (
          <>
            {/* Section header */}
            <div className="flex items-center justify-between gap-2 px-5 pb-2">
              <div className="flex items-center gap-2">
                <span className="h-px w-3 bg-[var(--dark-4)]" />
                <span className="label !text-[10px] !text-[var(--dark-text-3)]">
                  {currentProjectId ? "Project sessions" : "Standalone"}
                </span>
              </div>
              <span className="rounded-full bg-[var(--dark-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--dark-text-3)] ring-1 ring-inset ring-[var(--dark-4)]">
                {totalCount}
              </span>
            </div>

            {/* Segmented filter */}
            <div className="px-3 pb-2.5">
              <div className="flex items-center gap-0.5 rounded-[var(--r-sm)] bg-[var(--dark-2)] p-0.5 ring-1 ring-inset ring-[var(--line-dark)]">
                <SegmentButton active={filter === "all"} onClick={() => setFilter("all")}>
                  All
                  <span className="ml-1 opacity-50">{totalCount}</span>
                </SegmentButton>
                <SegmentButton active={filter === "starred"} onClick={() => setFilter("starred")}>
                  Starred
                  <span className="ml-1 opacity-50">{starredCount}</span>
                </SegmentButton>
              </div>
            </div>

            {/* Search — sidebar scope (live filter). Click the input to open
                the full-text dialog which searches across all sessions
                (incl. inside projects) up to a higher cap. */}
            <div className="px-3 pb-3">
              <div className="relative">
                <svg
                  viewBox="0 0 24 24"
                  className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--dark-text-3)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onFocus={() => setSearchDialogOpen(true)}
                  placeholder="Cari di semua session…"
                  className="block w-full cursor-pointer rounded-[var(--r-md)] border border-[var(--line-dark)] bg-[var(--dark-2)] py-2 pl-9 pr-12 text-xs text-[var(--dark-text)] placeholder:text-[var(--dark-text-3)] transition-colors focus:border-[var(--magenta-400)] focus:bg-[var(--dark-3)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta-500)]/30"
                />
                <button
                  type="button"
                  onClick={() => setSearchDialogOpen(true)}
                  className="absolute right-1.5 top-1/2 grid h-6 -translate-y-1/2 place-items-center rounded-[6px] px-1.5 text-[10px] font-mono text-[var(--dark-text-3)] transition-colors hover:bg-[var(--dark-3)] hover:text-[var(--dark-text-2)]"
                  title="Buka pencarian lengkap"
                  aria-label="Buka pencarian lengkap"
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Grouped list */}
            <div className="dark-scroll min-w-0 flex-1 overflow-y-auto px-3 pb-3">
              {!hasAny ? (
                <EmptyState hasSearch={!!search} hasFilter={filter !== "all"} scoped={currentProjectId != null} onClear={() => { setSearch(""); setFilter("all"); }} />
              ) : (
                <div className="space-y-4">
                  {/* Starred section — pinned at the top, hides when empty. */}
                  {starredList.length > 0 && (
                    <SessionGroup
                      label="Starred"
                      accent="starred"
                      sessions={starredList}
                      onClickSession={(s) => {
                        if (currentProjectId != null && s.project_id === currentProjectId) {
                          router.push(`/projects/${currentProjectId}/chat/${s.id}`);
                        } else {
                          onSelectSession(s);
                        }
                      }}
                      activeSessionId={activeSessionId}
                      onAction={(id, action) => {
                        const s = sessions.find((x) => x.id === id);
                        if (!s) return;
                        if (action === "star") toggleStar(id);
                        else if (action === "rename") startRename(s);
                        else if (action === "delete") deleteSession(id);
                      }}
                    />
                  )}
                  <SessionGroup label="Today" sessions={grouped.today} onClickSession={(s) => {
                    if (currentProjectId != null && s.project_id === currentProjectId) {
                      router.push(`/projects/${currentProjectId}/chat/${s.id}`);
                    } else {
                      onSelectSession(s);
                    }
                  }} activeSessionId={activeSessionId} onAction={(id, action) => {
                    const s = sessions.find((x) => x.id === id);
                    if (!s) return;
                    if (action === "star") toggleStar(id);
                    else if (action === "rename") startRename(s);
                    else if (action === "delete") deleteSession(id);
                  }} />
                  <SessionGroup label="This week" sessions={grouped.thisWeek} onClickSession={(s) => {
                    if (currentProjectId != null && s.project_id === currentProjectId) {
                      router.push(`/projects/${currentProjectId}/chat/${s.id}`);
                    } else {
                      onSelectSession(s);
                    }
                  }} activeSessionId={activeSessionId} onAction={(id, action) => {
                    const s = sessions.find((x) => x.id === id);
                    if (!s) return;
                    if (action === "star") toggleStar(id);
                    else if (action === "rename") startRename(s);
                    else if (action === "delete") deleteSession(id);
                  }} />
                  <SessionGroup label="Older" sessions={grouped.older} onClickSession={(s) => {
                    if (currentProjectId != null && s.project_id === currentProjectId) {
                      router.push(`/projects/${currentProjectId}/chat/${s.id}`);
                    } else {
                      onSelectSession(s);
                    }
                  }} activeSessionId={activeSessionId} onAction={(id, action) => {
                    const s = sessions.find((x) => x.id === id);
                    if (!s) return;
                    if (action === "star") toggleStar(id);
                    else if (action === "rename") startRename(s);
                    else if (action === "delete") deleteSession(id);
                  }} />
                </div>
              )}
            </div>
          </>
        )}

        {isAdminRoute && !isMini && <div className="flex-1" />}

        {isAdminRoute && isMini && <div className="flex-1" />}

        {user && (
          <div className={`border-t border-[var(--line-dark)] bg-[var(--dark-2)]/50 ${isMini ? "md:p-1.5" : "p-3"}`}>
            <UserMenu
              user={user}
              collapsed={isMini}
              onLogout={() => {
                logout();
                router.push("/login");
              }}
            />
          </div>
        )}
      </aside>

      <SessionSearchDialog
        open={searchDialogOpen}
        onClose={() => setSearchDialogOpen(false)}
        projects={projects}
      />
    </>
  );
}

function NavLink({
  href,
  icon,
  label,
  current,
  onClick,
  collapsed,
}: {
  href: string;
  icon: "home" | "folder" | "users" | "cpu";
  label: string;
  current?: boolean;
  onClick?: () => void;
  collapsed?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={`group flex items-center gap-2.5 rounded-[var(--r-sm)] px-2.5 py-1.5 text-[13px] transition-all ${
        collapsed ? "md:justify-center md:px-2 md:gap-0" : ""
      } ${
        current
          ? "bg-[var(--dark-3)] text-[var(--dark-text)] shadow-[inset_0_0_0_1px_var(--dark-4)]"
          : "text-[var(--dark-text-2)] hover:bg-[var(--dark-2)] hover:text-[var(--dark-text)]"
      }`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] transition-colors ${
          current
            ? "bg-[var(--saffron)]/20 text-[var(--saffron-200)]"
            : "bg-[var(--dark-3)]/60 text-[var(--dark-text-3)] group-hover:text-[var(--dark-text-2)]"
        }`}
      >
        {icon === "home" && <HomeIcon className="h-3.5 w-3.5" />}
        {icon === "folder" && <FolderIcon className="h-3.5 w-3.5" />}
        {icon === "users" && <UsersIcon className="h-3.5 w-3.5" />}
        {icon === "cpu" && <CpuIcon className="h-3.5 w-3.5" />}
      </span>
      <span className={`flex-1 font-medium ${collapsed ? "md:hidden" : ""}`}>{label}</span>
      {current && (
        <span className={`h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--saffron-300)] shadow-[0_0_8px_var(--saffron-300)] ${collapsed ? "md:hidden" : ""}`} />
      )}
    </Link>
  );
}

function SegmentButton({
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
      onClick={onClick}
      className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-[6px] py-1.5 text-[11px] font-medium transition-all ${
        active
          ? "bg-[var(--dark-3)] text-[var(--dark-text)] shadow-[inset_0_0_0_1px_var(--dark-4),0_1px_2px_rgba(0,0,0,0.2)]"
          : "text-[var(--dark-text-3)] hover:text-[var(--dark-text-2)]"
      }`}
    >
      {children}
    </button>
  );
}

function SessionGroup({
  label,
  sessions,
  onClickSession,
  activeSessionId,
  onAction,
  accent,
}: {
  label: string;
  sessions: Session[];
  onClickSession: (s: Session) => void;
  activeSessionId: number | null;
  onAction: (id: number, action: "star" | "rename" | "delete") => void;
  accent?: "starred";
}) {
  // Defensive: non-starred sections should NEVER render starred sessions,
  // even if the parent passed them through (e.g. stale state, optimistic
  // toggle, or cache layering). The Starred section renders them on its own.
  const filtered = accent === "starred"
    ? sessions
    : sessions.filter((s) => !s.starred);
  if (filtered.length === 0) return null;
  const isStarred = accent === "starred";
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-1.5">
        {isStarred && (
          <svg
            viewBox="0 0 24 24"
            className="h-3 w-3 text-[var(--saffron-200)]"
            fill="currentColor"
            aria-hidden
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        )}
        <span
          className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${
            isStarred ? "text-[var(--saffron-200)]" : "text-[var(--dark-text-3)]"
          }`}
        >
          {label}
        </span>
        <span
          className={`flex-1 border-t border-dashed ${
            isStarred ? "border-[var(--saffron-500)]/30" : "border-[var(--dark-4)]"
          }`}
        />
        <span
          className={`font-mono text-[10px] ${
            isStarred ? "text-[var(--saffron-200)]" : "text-[var(--dark-text-3)]"
          }`}
        >
          {sessions.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {filtered.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={activeSessionId === s.id}
            onClickRow={() => onClickSession(s)}
            onAction={(action) => onAction(s.id, action)}
          />
        ))}
      </ul>
    </section>
  );
}

function EmptyState({
  hasSearch,
  hasFilter,
  scoped,
  onClear,
}: {
  hasSearch: boolean;
  hasFilter: boolean;
  scoped: boolean;
  onClear: () => void;
}) {
  if (hasSearch || hasFilter) {
    return (
      <div className="px-2 py-8 text-center">
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-[var(--dark-3)] text-[var(--dark-text-3)]">
          <SearchOffIcon className="h-4 w-4" />
        </div>
        <p className="mt-3 text-xs text-[var(--dark-text-3)]">
          {hasSearch ? "Tidak ada hasil pencarian" : "Tidak ada starred session"}
        </p>
        <button
          onClick={onClear}
          className="mt-2 text-[11px] font-medium text-[var(--saffron-200)] hover:text-[var(--saffron-300)]"
        >
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="px-3 py-10 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-[var(--dark-3)] to-[var(--dark-2)] ring-1 ring-inset ring-[var(--dark-4)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-[var(--dark-text-3)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <p className="mt-3 text-xs font-medium text-[var(--dark-text-2)]">
        {scoped ? "Belum ada session di project ini" : "Mulai chat baru"}
      </p>
      <p className="mt-1 text-[11px] text-[var(--dark-text-3)]">
        Klik tombol "New chat" untuk mulai.
      </p>
    </div>
  );
}

/* Inline SVG icons */
function HomeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 12L12 4l9 8" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}
function FolderIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function UsersIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function SearchOffIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="8" x2="14" y2="14" />
    </svg>
  );
}
function CpuIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}