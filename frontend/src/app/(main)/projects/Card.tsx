"use client";

import Link from "next/link";
import { Pill } from "@/components/ui/Pill";

export type Project = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  archived_at: string | null;
  session_count?: number;
  owner_username?: string;
};

export function ProjectCard({
  project,
  onArchive,
  onDelete,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <div className="card-hover card group relative flex flex-col overflow-hidden">
      {/* Color band — gradient from project color → transparent */}
      <div
        className="absolute inset-x-0 top-0 h-1.5 transition-all group-hover:h-2"
        style={{
          background: `linear-gradient(90deg, ${project.color} 0%, ${project.color}88 40%, transparent 100%)`,
        }}
      />
      {/* Soft tinted background wash */}
      <div
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-0 blur-2xl transition-opacity group-hover:opacity-30"
        style={{ background: project.color }}
      />

      <Link href={`/projects/${project.id}`} className="flex flex-1 flex-col gap-3 px-5 pt-6 pb-4">
        {/* Header: badge + status */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-md)] text-base font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_2px_6px_rgba(0,0,0,0.08)]"
              style={{ background: project.color }}
              aria-hidden
            >
              {project.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold tracking-tight text-[var(--ink)]">
                {project.name}
              </h3>
              {project.owner_username && (
                <p className="flex items-center gap-1 text-[11px] text-[var(--ink-3)]">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                  <span>@{project.owner_username}</span>
                </p>
              )}
            </div>
          </div>
          {project.archived_at && <Pill tone="neutral">archived</Pill>}
        </div>

        {/* Description */}
        <div className="min-h-[2.5em]">
          {project.description ? (
            <p className="line-clamp-2 text-sm leading-relaxed text-[var(--ink-2)]">{project.description}</p>
          ) : (
            <p className="text-xs italic text-[var(--ink-4)]">No description yet</p>
          )}
        </div>

        {/* Footer stat */}
        <div className="flex items-center gap-2 border-t border-[var(--line)] pt-3">
          <div className="flex items-center gap-1.5 text-xs text-[var(--ink-2)]">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[var(--ink-3)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="font-semibold text-[var(--ink)]">{project.session_count ?? 0}</span>
            <span>session{(project.session_count ?? 0) === 1 ? "" : "s"}</span>
          </div>
        </div>
      </Link>

      {/* Hover action overlay */}
      <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--paper-2)]/60 px-3 py-2 backdrop-blur-sm">
        <Link
          href={`/projects/${project.id}`}
          className="group/open inline-flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-xs font-medium text-[var(--magenta-700)] transition-all hover:bg-[var(--paper-2)]"
        >
          <span>Open</span>
          <svg viewBox="0 0 24 24" className="h-3 w-3 transition-transform group-hover/open:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </Link>
        <div className="flex gap-0.5">
          <button
            onClick={() => onArchive(!project.archived_at)}
            className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)]"
            title={project.archived_at ? "Unarchive" : "Archive"}
          >
            {project.archived_at ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
              </svg>
            )}
          </button>
          <button
            onClick={onDelete}
            className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] text-[var(--ink-3)] transition-colors hover:bg-[var(--danger-50)] hover:text-[var(--danger)]"
            title="Delete"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}