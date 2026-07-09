"use client";

export function JumpToBottom({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--paper-3)] px-3 text-xs font-medium text-[var(--ink-2)] shadow-[var(--shadow-3)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </svg>
        <span>Jump to latest</span>
      </button>
    </div>
  );
}