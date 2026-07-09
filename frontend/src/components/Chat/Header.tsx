"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pill } from "@/components/ui/Pill";
import type { Project, Session } from "@/components/Sidebar/types";

export type ModelOption = { value: string; label: string };

export function ChatHeader({
  activeSession,
  project,
  stale,
  info,
  model,
  onChangeModel,
  effort,
  onChangeEffort,
  modelOptions,
}: {
  activeSession: Session | null;
  project: Project | null;
  stale: boolean;
  info: string | null;
  model: string;
  onChangeModel: (m: string) => void;
  effort: string;
  onChangeEffort: (e: string) => void;
  /**
   * Models to render in the dropdown. Sourced from the admin-managed
   * registry via `useModels()`. If the registry is still loading or the
   * network call failed, the consumer passes a small fallback list — this
   * way the dropdown is never empty.
   */
  modelOptions: ModelOption[];
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  // Whether the project pill should toggle the in-page settings panel
  // (mounted on /projects/[id] and /projects/[id]/chat/[sessionId]) or
  // navigate to that route from elsewhere. Detected by route prefix so any
  // session bound to a project gets a discoverable affordance to reach
  // the config.
  const pathname = usePathname();
  const onProjectRoute =
    pathname != null && /^\/projects\/\d+(\/.*)?$/.test(pathname);
  // Track the sidebar's persisted mode so we can show the "show sidebar"
  // button on desktop only when the rail is currently off-screen. The
  // actual state lives in AppShell; we mirror it here via localStorage +
  // the same custom events that AppShell uses to mutate it. Cheaper than
  // threading the prop through every Chat consumer.
  //
  // We also gate by viewport — the "show sidebar" button is desktop-only.
  // On mobile the drawer is the user-facing concept; there's no hidden
  // mode to recover from (the hamburger toggles the drawer directly).
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mql.matches);
    function onMql(e: MediaQueryListEvent) { setIsDesktop(e.matches); }
    mql.addEventListener("change", onMql);
    try {
      setSidebarHidden(
        window.localStorage.getItem("app-shell:sidebar-mode") === "hidden"
      );
    } catch {
      /* localStorage may be blocked — keep false */
    }
    function onChange() {
      try {
        setSidebarHidden(
          window.localStorage.getItem("app-shell:sidebar-mode") === "hidden"
        );
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("app:show-sidebar", onChange);
    window.addEventListener("app:hide-sidebar", onChange);
    window.addEventListener("app:cycle-sidebar", onChange);
    return () => {
      mql.removeEventListener("change", onMql);
      window.removeEventListener("app:show-sidebar", onChange);
      window.removeEventListener("app:hide-sidebar", onChange);
      window.removeEventListener("app:cycle-sidebar", onChange);
    };
  }, []);

  function openSidebar() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app:open-sidebar"));
    }
  }
  function showSidebar() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app:show-sidebar"));
    }
  }
  function toggleProjectSettings() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("app:toggle-project-settings"));
    }
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-[var(--line)] bg-[var(--paper)]/80 px-4 backdrop-blur-xl">
      {/* Mobile hamburger — always shown below md. Toggles the drawer. */}
      <button
        type="button"
        onClick={openSidebar}
        aria-label="Open sidebar"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)] md:hidden"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>

      {/* Desktop "show sidebar" — only when the rail is currently in the
          "hidden" mode. Companion to the sidebar's collapse-to-hidden path
          so the user can always bring the rail back without a keyboard
          shortcut. Conditional on `sidebarHidden` so it's invisible while
          the rail is in full or mini mode. */}
      {sidebarHidden && (
        <button
          type="button"
          onClick={showSidebar}
          aria-label="Show sidebar"
          title="Tampilkan sidebar"
          className="hidden h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)] md:grid"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      )}

      {/* Title block */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {project && (
          // Project pill is a control, not just a label. On a project route
          // it toggles the in-page settings bottom-sheet (the same event
          // the mobile FAB uses); on any other route it links to the
          // project detail so users can reach the config from a standalone
          // session that has a project bound via the Composer picker.
          onProjectRoute ? (
            <button
              type="button"
              onClick={toggleProjectSettings}
              title="Pengaturan project"
              aria-label="Pengaturan project"
              className="group inline-flex items-center gap-1.5 rounded-full bg-[var(--magenta-50)] px-2 py-0.5 text-[11px] font-semibold text-[var(--magenta-700)] ring-1 ring-inset ring-[var(--magenta-200)] transition-colors hover:bg-[var(--magenta-100)]"
            >
              <span
                className="h-2 w-2 rounded-full ring-1 ring-inset ring-black/10"
                style={{ background: project.color }}
              />
              {project.name}
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          ) : (
            <Link
              href={`/projects/${project.id}`}
              title="Buka pengaturan project"
              aria-label="Buka pengaturan project"
              className="group inline-flex items-center gap-1.5 rounded-full bg-[var(--magenta-50)] px-2 py-0.5 text-[11px] font-semibold text-[var(--magenta-700)] ring-1 ring-inset ring-[var(--magenta-200)] transition-colors hover:bg-[var(--magenta-100)]"
            >
              <span
                className="h-2 w-2 rounded-full ring-1 ring-inset ring-black/10"
                style={{ background: project.color }}
              />
              {project.name}
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Link>
          )
        )}
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="truncate text-sm font-semibold tracking-tight text-[var(--ink)]">
            {activeSession?.title || (activeSession ? `Session #${activeSession.id}` : "New session")}
          </h1>
          {info && (
            <span className="truncate text-[11px] text-[var(--ink-3)]">{info}</span>
          )}
        </div>
        {stale && (
          <Pill tone="warning">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--warning)]" />
            <span>no heartbeat</span>
          </Pill>
        )}
      </div>

      {/* Project settings entry — sits in the navbar, only when this chat
          is bound to a project, and only on mobile (the desktop right rail
          makes it redundant there). Visible regardless of which sub-route
          we're on: on a project route it dispatches the toggle event; from
          a standalone chat it links to /projects/[id] so the user can
          reach the config from a session that was attached to a project
          via the Composer picker. Lives in the gap between the title
          block and the model picker so it doesn't crowd either side. */}
      {project && (
        onProjectRoute ? (
          <button
            type="button"
            onClick={toggleProjectSettings}
            aria-label="Pengaturan project"
            title="Pengaturan project"
            className="ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)] md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        ) : (
          <Link
            href={`/projects/${project.id}`}
            aria-label="Buka pengaturan project"
            title="Pengaturan project"
            className="ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)] md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        )
      )}

      <div className="hidden items-center gap-2 sm:flex">
        <SelectPill
          label="Effort"
          value={effort}
          tone="saffron"
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "XHigh" },
            { value: "max", label: "Max" },
          ]}
          onChange={onChangeEffort}
          open={effortOpen}
          setOpen={(o) => { setEffortOpen(o); if (o) setModelOpen(false); }}
        />
        <SelectPill
          label="Model"
          value={model}
          tone="magenta"
          options={modelOptions}
          onChange={onChangeModel}
          open={modelOpen}
          setOpen={(o) => { setModelOpen(o); if (o) setEffortOpen(false); }}
        />
      </div>
    </header>
  );
}

function SelectPill({
  label,
  value,
  tone,
  options,
  onChange,
  open,
  setOpen,
}: {
  label: string;
  value: string;
  tone: "magenta" | "saffron";
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const current = options.find((o) => o.value === value);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  const activeTone = tone === "saffron"
    ? "border-[var(--saffron)] bg-[var(--saffron-50)] text-[var(--saffron-500)]"
    : "border-[var(--magenta)] bg-[var(--magenta-50)] text-[var(--magenta-700)]";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`group inline-flex h-9 items-center gap-1.5 rounded-[var(--r-md)] border px-3 text-xs font-semibold transition-all ${
          open
            ? activeTone + " shadow-[var(--shadow-focus)]"
            : "border-[var(--line)] bg-[var(--paper-3)] text-[var(--ink-2)] hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:text-[var(--ink)] hover:shadow-[var(--shadow-2)]"
        }`}
      >
        <span className={`text-[10px] uppercase tracking-[0.08em] ${open ? "" : "text-[var(--ink-3)]"}`}>{label}</span>
        <span className={`h-0.5 w-0.5 rounded-full ${tone === "saffron" ? "bg-[var(--saffron-300)]" : "bg-[var(--magenta-300)]"}`} />
        <span>{current?.label || value}</span>
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="anim-scale-in absolute right-0 top-full z-30 mt-1.5 w-52 overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] py-1 shadow-[var(--shadow-4)]"
        >
          <div className="border-b border-[var(--line)] bg-[var(--paper-2)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
            Pilih {label}
          </div>
          {options.map((o) => {
            const isSel = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={isSel}>
                <button
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                    isSel
                      ? tone === "saffron"
                        ? "bg-[var(--saffron-50)] text-[var(--saffron-500)]"
                        : "bg-[var(--magenta-50)] text-[var(--magenta-700)]"
                      : "text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                  }`}
                >
                  <span>{o.label}</span>
                  {isSel && (
                    <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${tone === "saffron" ? "text-[var(--saffron-500)]" : "text-[var(--magenta-600)]"}`} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}