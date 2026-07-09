"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth";
import { CenteredDialog } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import type { Project, Session } from "./types";

type Props = {
  open: boolean;
  onClose: () => void;
  projects: Project[];
};

type SessionHit = Session & {
  owner_username?: string;
};

/**
 * Full-text session search dialog. Searches across BOTH standalone sessions
 * and sessions inside projects (the sidebar only shows one scope at a time
 * depending on the route). Backed by `GET /api/sessions?q=...&limit=500`
 * which LIKE-matches against the session title.
 */
export function SessionSearchDialog({ open, onClose, projects }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SessionHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Focus input when dialog opens, reset query when it closes. Also install
  // our own document-level Escape handler — the underlying CenteredDialog
  // already does this, but if anything in the parent stack intercepts
  // keydown (e.g. IME composition), our backup still catches Esc cleanly.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
      setActiveIdx(0);
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    // Capture phase so we run before any descendant handler that might
    // preventDefault and swallow the event.
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
    };
  }, [open, onClose]);

  // Debounced server search. Empty query → no fetch (just show empty state).
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setActiveIdx(0);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      // 500ms debounce — long enough that fast typing collapses into a
      // single request, short enough that the spinner doesn't feel sluggish.
      try {
        const r = await authFetch(
          `/api/sessions?q=${encodeURIComponent(q)}&limit=200`
        );
        const data = (await r.json()) as SessionHit[];
        if (!cancelled) {
          setHits(data);
          setActiveIdx(0);
        }
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open]);

  function gotoSession(s: SessionHit) {
    onClose();
    if (s.project_id) {
      router.push(`/projects/${s.project_id}/chat/${s.id}`);
    } else {
      router.push(`/chat/${s.id}`);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = hits[activeIdx];
      if (target) gotoSession(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center justify-between gap-2">
          <span>Cari session</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="grid h-7 w-7 place-items-center rounded-[var(--r-md)] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      }
      description="Ketik judul atau nomor ID. Mencakup semua session, termasuk yang ada di dalam project."
      widthClass="max-w-2xl"
    >
      <div className="-mx-1">
        {/* Search input */}
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-3)]"
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
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Cari judul atau #ID session…"
            className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] py-2.5 pl-10 pr-3 text-[14px] text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:border-[var(--magenta-300)] focus:bg-[var(--paper-3)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta-500)]/20"
          />
          {loading && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--saffron)]" />
              <span className="pulse-dot mx-0.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--saffron)]" />
              <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--saffron)]" />
            </span>
          )}
        </div>

        {/* Results */}
        <div className="dark-scroll mt-3 max-h-[60vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]">
          {query.trim() === "" ? (
            <EmptyHint />
          ) : hits.length === 0 && !loading ? (
            <NoResults q={query} />
          ) : (
            <ul role="listbox" className="py-1">
              {hits.map((s, i) => (
                <HitRow
                  key={s.id}
                  session={s}
                  projects={projects}
                  active={i === activeIdx}
                  onClick={() => gotoSession(s)}
                  onHover={() => setActiveIdx(i)}
                  query={query}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint + explicit close */}
        <div className="mt-2.5 flex items-center justify-between text-[11px] text-[var(--ink-3)]">
          <span className="flex items-center gap-1.5">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>
            <span>navigasi</span>
            <span className="mx-1">·</span>
            <kbd className="kbd">⏎</kbd>
            <span>buka</span>
            <span className="mx-1">·</span>
            <kbd className="kbd">Esc</kbd>
            <span>tutup</span>
          </span>
          <span className="flex items-center gap-2">
            {hits.length > 0 && <span>{hits.length} hasil</span>}
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-2 py-1 text-[11px] font-medium text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
            >
              Tutup
            </button>
          </span>
        </div>
      </div>
    </CenteredDialog>
  );
}

function HitRow({
  session: s,
  projects,
  active,
  onClick,
  onHover,
  query,
}: {
  session: SessionHit;
  projects: Project[];
  active: boolean;
  onClick: () => void;
  onHover: () => void;
  query: string;
}) {
  const project = projects.find((p) => p.id === s.project_id);
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={onHover}
        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
          active
            ? "bg-[var(--magenta-50)] text-[var(--ink)]"
            : "text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
        }`}
      >
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-sm)] text-[11px] font-semibold ${
            s.starred
              ? "bg-[var(--saffron)]/15 text-[var(--saffron-700)] ring-1 ring-inset ring-[var(--saffron-500)]/30"
              : "bg-[var(--paper-3)] text-[var(--ink-3)]"
          }`}
        >
          {s.starred ? "★" : "#"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="block truncate text-[13px]">
              <Highlight text={s.title || `Session #${s.id}`} query={query} />
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--ink-3)]">
            {project && (
              <>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                  style={{ background: project.color }}
                />
                <span className="truncate font-medium text-[var(--ink-2)]">{project.name}</span>
                <span className="text-[var(--ink-4)]">·</span>
              </>
            )}
            <span>#{s.id}</span>
            <span className="text-[var(--ink-4)]">·</span>
            <span>{formatRelative(s.updated_at)}</span>
          </span>
        </span>
        <Pill tone={project ? "magenta" : "neutral"}>
          {project ? "in project" : "standalone"}
        </Pill>
      </button>
    </li>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  // Case-insensitive split, preserving original casing in output.
  const re = new RegExp(`(${escapeRegExp(q)})`, "ig");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-[3px] bg-[var(--saffron-100)] px-0.5 text-[var(--ink)]"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatRelative(iso: string) {
  const d = new Date(iso);
  const diffH = (Date.now() - d.getTime()) / 3.6e6;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  if (diffH < 24 * 7) return `${Math.floor(diffH / 24)}d ago`;
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--paper-3)] text-[var(--ink-3)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <p className="text-[12px] font-medium text-[var(--ink-2)]">Mulai mengetik</p>
      <p className="max-w-[280px] text-[11px] text-[var(--ink-3)]">
        Hasil pencarian akan muncul di sini. Mencakup semua session, baik standalone maupun di dalam project.
      </p>
    </div>
  );
}

function NoResults({ q }: { q: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full bg-[var(--paper-3)] text-[var(--ink-3)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
          <line x1="8" y1="8" x2="14" y2="14" />
        </svg>
      </div>
      <p className="text-[12px] font-medium text-[var(--ink-2)]">Tidak ada hasil</p>
      <p className="max-w-[280px] text-[11px] text-[var(--ink-3)]">
        Tidak ada session dengan judul mengandung "<span className="font-mono">{q}</span>".
      </p>
    </div>
  );
}