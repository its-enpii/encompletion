"use client";

import Link from "next/link";
import { BrandMark } from "@/components/ui/BrandMark";

type Mode = "full" | "mini" | "hidden";

export function Brand({
  onCloseMobile,
  onCycleMode,
  mode = "full",
}: {
  onCloseMobile?: () => void;
  onCycleMode?: () => void;
  mode?: Mode;
}) {
  return (
    <div
      className={`relative flex items-center gap-2 px-4 pt-5 pb-4 ${
        mode === "mini" ? "md:justify-center md:px-2" : "justify-between"
      }`}
    >
      <Link
        href="/new"
        className="group inline-flex items-center rounded-[var(--r-sm)] focus-visible:ring-2 focus-visible:ring-[var(--saffron)]/40 focus-visible:outline-none"
        onClick={onCloseMobile}
      >
        <BrandMark size="md" tone="dark" collapsed={mode === "mini" || mode === "hidden"} />
      </Link>

      {/* Desktop cycle button: only meaningful in full/mini. Hidden mode is
         mobile-only (the navbar hamburger owns that flow on mobile, and on
         desktop the navbar shows a "show sidebar" button when hidden). The
         `hidden md:grid` keeps the cycle button out of the mobile layout
         so it doesn't fight with the navbar hamburger. In mini mode the
         button floats to the right edge of the rail via absolute
         positioning so it doesn't stack on top of the centered BrandMark.

         The button wears a soft visible chrome (subtle border + faint
         background) so it doesn't disappear into the dark sidebar surface;
         on hover the border tightens and the icon turns saffron for clear
         affordance. */}
      {onCycleMode && (
        <button
          type="button"
          onClick={onCycleMode}
          aria-label={mode === "mini" ? "Expand sidebar" : "Collapse sidebar"}
          title={mode === "mini" ? "Expand (full)" : "Collapse (mini)"}
          className={`hidden h-8 w-8 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line-dark)] bg-[var(--dark-3)]/70 text-[var(--dark-text-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--saffron-500)]/40 hover:bg-[var(--dark-2)] hover:text-[var(--saffron-200)] md:grid ${
            mode === "mini" ? "md:absolute md:right-1 md:top-1/2 md:-translate-y-1/2" : ""
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {mode === "mini" ? (
              <polyline points="9 18 15 12 9 6" />
            ) : (
              <polyline points="15 18 9 12 15 6" />
            )}
          </svg>
        </button>
      )}

      {/* Mobile close button — keeps the drawer UX clean. Hidden on md+
         because the desktop cycle button covers the same role (collapse
         to mini) there. Backdrop click is the secondary way to close. */}
      {onCloseMobile && (
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line-dark)] bg-[var(--dark-3)]/70 text-[var(--dark-text-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--saffron-500)]/40 hover:bg-[var(--dark-2)] hover:text-[var(--saffron-200)] md:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}