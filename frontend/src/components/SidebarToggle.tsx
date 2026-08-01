"use client";

export function SidebarToggle() {
  function toggleSidebar() {
    window.dispatchEvent(new CustomEvent("app:open-sidebar"));
  }

  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-label="Toggle sidebar"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--magenta-500)]/40"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </svg>
    </button>
  );
}
