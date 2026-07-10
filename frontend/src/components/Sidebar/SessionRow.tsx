"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "./types";

function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffH = (now.getTime() - d.getTime()) / 3.6e6;
  if (diffH < 1) return "now";
  if (diffH < 24) return `${Math.floor(diffH)}h`;
  if (diffH < 24 * 7) return d.toLocaleDateString("id-ID", { weekday: "short" });
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

export function SessionRow({
  session: s,
  active,
  onClickRow,
  onAction,
}: {
  session: Session;
  active: boolean;
  onClickRow: () => void;
  onAction: (action: "star" | "rename" | "delete") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Defer showing quick actions so a click that just entered the row
  // (intended for the row itself) isn't intercepted by an action button
  // that pops in under the cursor.
  const [actionsReady, setActionsReady] = useState(false);
  useEffect(() => {
    if (!hovered) { setActionsReady(false); return; }
    const t = setTimeout(() => setActionsReady(true), 150);
    return () => clearTimeout(t);
  }, [hovered]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      // Use composedPath so we can detect clicks inside portals or shadow DOM
      // — falls back gracefully to contains() for normal ancestors.
      const path = e.composedPath();
      const inside = path.some(
        (n) => n instanceof Node && menuRef.current?.contains(n)
      );
      if (!inside) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    // Use `click` (not `mousedown`) so React's onClick handler on a MenuItem
    // fires FIRST; only when the click bubbles up to document and the target
    // is outside the menu do we close. mousedown would fire earlier and
    // unmount the menu before React's synthetic click event runs.
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <li
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`group relative rounded-[var(--r-sm)] ${
          // Active row swap used transition-all duration-150; in practice
          // it produced a perceivable "blink" across the whole list every
          // time the operator selected a session because every row's
          // wrapper re-applied its transition. Drop the transition so
          // state changes are instant — the active gradient itself is
          // already a strong enough affordance.
          active
            ? "bg-gradient-to-r from-[var(--magenta-700)]/20 via-[var(--magenta-700)]/15 to-transparent text-[var(--dark-text)] shadow-[inset_2px_0_0_var(--saffron-300),inset_0_0_0_1px_var(--magenta-700)]/40"
            : "text-[var(--dark-text-2)] hover:bg-[var(--dark-2)] hover:text-[var(--dark-text)]"
        }`}
        style={active ? {
          background: "linear-gradient(90deg, rgba(168,71,129,0.25), rgba(168,71,129,0.10) 60%, transparent)",
          boxShadow: "inset 2px 0 0 var(--saffron-300), inset 0 0 0 1px rgba(168,71,129,0.30)",
        } : undefined}
      >
        <button
          type="button"
          onClick={onClickRow}
          className="flex min-w-0 w-full items-start gap-2.5 px-2.5 py-2 text-left"
        >
          {/* Avatar / status indicator — saffron star for starred, # for normal.
              When this row is the active session, the avatar gets a saffron
              gradient AND a pulsing saffron ring so it's instantly identifiable
              in the sidebar without needing to read the title. */}
          <span
            className={`relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-xs font-semibold transition-all ${
              active
                ? "bg-gradient-to-br from-[var(--saffron-300)] to-[var(--saffron-500)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                : s.starred
                  ? "bg-[var(--saffron)]/15 text-[var(--saffron-200)] ring-1 ring-inset ring-[var(--saffron-500)]/30"
                  : "bg-[var(--dark-3)] text-[var(--dark-text-3)]"
            }`}
          >
            {s.starred ? "★" : "#"}
            {active && (
              <>
                {/* Static ring around the active session's avatar —
                    the original implementation used animate-ping (a
                    ping-out ring) which produced a visible "blink"
                    whenever the active row changed. A subtle pulsing
                    background is enough to mark the row without a
                    jarring expansion animation. */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[var(--r-sm)] ring-2 ring-[var(--saffron-300)]"
                />
              </>
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span className={`flex items-center gap-1.5 ${active ? "font-semibold text-[var(--dark-text)]" : ""}`}>
              <span className="block truncate text-[13px]">
                {s.title || `Session #${s.id}`}
              </span>
              {active && (
                /* "Sekarang" pill — tiny saffron label so the active row is
                   locatable even when scrolled fast, regardless of title length. */
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--saffron)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--saffron-200)] ring-1 ring-inset ring-[var(--saffron-500)]/30"
                  aria-label="Session ini sedang dibuka"
                >
                  <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--saffron-200)] shadow-[0_0_6px_var(--saffron-300)]" />
                  Sekarang
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--dark-text-3)]">
              <span>{fmtTime(s.updated_at)}</span>
              {s.total_cost_usd > 0 && (
                <>
                  <span className="h-0.5 w-0.5 rounded-full bg-[var(--dark-text-3)]" />
                  <span className="font-mono text-[var(--saffron-200)]">
                    ${s.total_cost_usd.toFixed(3)}
                  </span>
                </>
              )}
            </span>
          </span>
        </button>

        {/* Menu trigger + dropdown panel — both wrapped in a single ref'd
            container so the outside-click listener (mousedown) considers the
            whole menu a single target. Without this the mousedown on a
            MenuItem fires the outside-click handler BEFORE React's click
            event, closing the menu before onClick runs. */}
        <div ref={menuRef}>
          {(actionsReady || menuOpen) && (
            <div
              className="anim-fade-in absolute right-1.5 top-1.5 z-40 flex items-center rounded-[var(--r-sm)] bg-[var(--dark-3)]/95 p-0.5 shadow-[var(--shadow-2)] ring-1 ring-inset ring-[var(--dark-4)] backdrop-blur-sm"
            >
              <QuickAction title="More actions" onClick={() => setMenuOpen((v) => !v)}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </QuickAction>
            </div>
          )}

          {menuOpen && (
            <div
              role="menu"
              className="anim-scale-in absolute right-1 top-9 z-50 w-48 overflow-hidden rounded-[var(--r-md)] border border-[var(--line-dark)] bg-[var(--dark-2)] py-1 shadow-[var(--shadow-4)]"
            >
              <MenuItem
                icon={
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={s.starred ? "var(--saffron-200)" : "none"} stroke={s.starred ? "var(--saffron-200)" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                }
                label={s.starred ? "Unstar" : "Star"}
                onClick={() => { setMenuOpen(false); onAction("star"); }}
              />
              <MenuItem
                icon={<PencilIcon className="h-3.5 w-3.5" />}
                label="Rename"
                onClick={() => { setMenuOpen(false); onAction("rename"); }}
              />
              <MenuItem
                icon={<ShareIcon className="h-3.5 w-3.5" />}
                label="Copy link"
                onClick={() => {
                  setMenuOpen(false);
                  navigator.clipboard.writeText(`${window.location.origin}/chat/${s.id}`).catch(() => {});
                }}
              />
              <div className="my-1 mx-2 border-t border-[var(--dark-4)]" />
              <MenuItem
                icon={<TrashIcon className="h-3.5 w-3.5" />}
                label="Delete"
                danger
                onClick={() => { setMenuOpen(false); onAction("delete"); }}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function QuickAction({
  title,
  active,
  children,
  onClick,
}: {
  title: string;
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`grid h-6 w-6 place-items-center rounded-[5px] text-xs transition-all ${
        active
          ? "text-[var(--saffron-200)]"
          : "text-[var(--dark-text-3)] hover:bg-[var(--dark-3)] hover:text-[var(--dark-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors ${
        danger
          ? "text-[var(--danger)] hover:bg-[var(--danger-50)]/10"
          : "text-[var(--dark-text-2)] hover:bg-[var(--dark-3)] hover:text-[var(--dark-text)]"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  );
}
function ShareIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}
function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}