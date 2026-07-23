"use client";

import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Card } from "@/components/ui/Card";
import { ProjectCard, type Project } from "./Card";
import { NewProjectDialog } from "./NewProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { EmptyProjectsView } from "./EmptyStateView";

type SortKey = "recent" | "name" | "sessions";
type ViewMode = "grid" | "list";

export default function ProjectsPage() {
  const { toast } = useUi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("recent");
  const [view, setView] = useState<ViewMode>("grid");

  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  async function load() {
    setLoading(true);
    try {
      const qs = showArchived ? "" : "?include_archived=0";
      const data: Project[] = await authFetch(`/api/projects${qs}`).then((r) => r.json());
      setProjects(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [showArchived]);

  async function create(payload: { name: string; description: string | null; color: string }) {
    const r = await authFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    await load();
  }

  async function archive(id: number, archived: boolean) {
    const r = await authFetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!r.ok) toast("Gagal update arsip", "error");
    await load();
  }

  async function remove(id: number) {
    const r = await authFetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    await load();
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = projects;
    if (q) {
      arr = arr.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description || "").toLowerCase().includes(q)
      );
    }
    arr = [...arr];
    if (sortBy === "name") arr.sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "sessions") arr.sort((a, b) => (b.session_count || 0) - (a.session_count || 0));
    return arr;
  }, [projects, search, sortBy]);

  const activeCount = projects.filter((p) => !p.archived_at).length;

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-10">
          {/* Hero header */}
          <div className="mb-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--magenta-700)]">
                  <span className="h-px w-6 bg-[var(--magenta-500)]" />
                  Workspace
                </div>
                <div className="flex items-baseline gap-3">
                  <h1 className="text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    Projects
                  </h1>
                  <Pill>{projects.length}</Pill>
                  <span className="text-sm text-[var(--ink-3)]">
                    · {activeCount} active
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--ink-3)]">
                  Kelompokkan session berdasarkan topik. Instructions &amp; knowledge tiap project
                  di-inject ke system prompt saat session dimulai.
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={() => setShowForm(true)}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>New project</span>
              </Button>
            </div>
          </div>

          {/* Toolbar */}
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
                  placeholder="Cari project berdasarkan nama atau deskripsi…"
                  className="block w-full rounded-[var(--r-md)] border border-transparent bg-[var(--paper-2)] py-2 pl-9 pr-3 text-sm placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:bg-[var(--paper-3)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                />
              </div>

              {/* Segmented sort */}
              <div className="flex items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
                {(["recent", "name", "sessions"] as SortKey[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setSortBy(k)}
                    className={`rounded-[6px] px-3 py-1 text-xs font-medium capitalize transition-all ${
                      sortBy === k
                        ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                        : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>

              {/* View toggle */}
              <div className="flex items-center gap-0.5 rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
                <button
                  onClick={() => setView("grid")}
                  className={`grid h-7 w-7 place-items-center rounded-[6px] transition-all ${
                    view === "grid"
                      ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                      : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                  }`}
                  title="Grid view"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                  </svg>
                </button>
                <button
                  onClick={() => setView("list")}
                  className={`grid h-7 w-7 place-items-center rounded-[6px] transition-all ${
                    view === "list"
                      ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                      : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                  }`}
                  title="List view"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Archived toggle */}
              <button
                onClick={() => setShowArchived((v) => !v)}
                className={`inline-flex items-center gap-2 rounded-[var(--r-md)] border px-3 py-1 text-xs font-medium transition-colors ${
                  showArchived
                    ? "border-[var(--magenta)] bg-[var(--magenta-50)] text-[var(--magenta-700)]"
                    : "border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
                }`}
              >
                {showArchived ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )}
                <span>archived</span>
              </button>
            </div>
          </Card>

          {/* Content */}
          {loading ? (
            <div className={view === "grid" ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-2"}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card h-48 animate-pulse" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyProjectsView
              search={search}
              showArchived={showArchived}
              onCreate={() => setShowForm(true)}
              onClearSearch={() => setSearch("")}
            />
          ) : view === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onArchive={(v) => archive(p.id, v)}
                  onDelete={() => setDeleteTarget(p)}
                />
              ))}
            </div>
          ) : (
            <ProjectList projects={visible} onArchive={archive} onDelete={(p) => setDeleteTarget(p)} />
          )}

          <NewProjectDialog
            open={showForm}
            onClose={() => setShowForm(false)}
            onCreate={create}
          />

          {deleteTarget && (
            <DeleteProjectDialog
              open
              projectName={deleteTarget.name}
              sessionCount={deleteTarget.session_count ?? 0}
              onClose={() => setDeleteTarget(null)}
              onConfirm={() => remove(deleteTarget.id)}
            />
          )}
        </div>
      </div>
    </>
  );
}

function ProjectList({
  projects,
  onArchive,
  onDelete,
}: {
  projects: Project[];
  onArchive: (id: number, archived: boolean) => void;
  onDelete: (p: Project) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--line)] bg-[var(--paper-2)] text-left text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
            <th className="px-4 py-3 font-semibold">Project</th>
            <th className="px-4 py-3 font-semibold">Sessions</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} className="group border-b border-[var(--line)] last:border-0 transition-colors hover:bg-[var(--paper-2)]/60">
              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span
                    className="grid h-9 w-9 place-items-center rounded-[var(--r-md)] text-sm font-semibold text-white shadow-[var(--shadow-1)]"
                    style={{ background: p.color }}
                  >
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div className="font-medium text-[var(--ink)]">{p.name}</div>
                    {p.description && (
                      <div className="mt-0.5 line-clamp-1 text-xs text-[var(--ink-3)]">{p.description}</div>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-[var(--ink-2)]">{p.session_count ?? 0}</td>
              <td className="px-4 py-3">
                {p.archived_at
                  ? <Pill tone="neutral">archived</Pill>
                  : <Pill tone="success">active</Pill>}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => onArchive(p.id, !p.archived_at)}
                    className="rounded-[var(--r-sm)] px-2 py-1 text-xs text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)]"
                  >
                    {p.archived_at ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    onClick={() => onDelete(p)}
                    className="rounded-[var(--r-sm)] px-2 py-1 text-xs text-[var(--ink-3)] transition-colors hover:bg-[var(--danger-50)] hover:text-[var(--danger)]"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
