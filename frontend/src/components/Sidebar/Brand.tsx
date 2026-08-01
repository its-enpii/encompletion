"use client";

import Link from "next/link";
import { BrandMark } from "@/components/ui/BrandMark";

export function Brand({ onCloseMobile }: { onCloseMobile?: () => void }) {
  return (
    <div className="relative flex items-center justify-between gap-2 px-4 pt-5 pb-4">
      <Link
        href="/new"
        className="group inline-flex items-center rounded-[var(--r-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--saffron)]/40"
        onClick={onCloseMobile}
      >
        <BrandMark size="md" tone="dark" />
      </Link>

      {onCloseMobile && (
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line-dark)] bg-[var(--dark-3)]/70 text-[var(--dark-text-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--saffron-500)]/40 hover:bg-[var(--dark-2)] hover:text-[var(--saffron-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--saffron)]/60 md:hidden"
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
