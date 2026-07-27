"use client";

import { useEffect, useState } from "react";

/**
 * Sidebar affordance for pages without Chat Header.
 * Mobile: hamburger opens the drawer.
 * Desktop: only when rail is "hidden" — restores full mode.
 */
export function SidebarToggle() {
  const [sidebarHidden, setSidebarHidden] = useState(false);

  useEffect(() => {
    function read() {
      try {
        setSidebarHidden(
          window.localStorage.getItem("app-shell:sidebar-mode") === "hidden"
        );
      } catch {
        setSidebarHidden(false);
      }
    }
    read();
    function onStorage(e: StorageEvent) {
      if (e.key === "app-shell:sidebar-mode") read();
    }
    function onShow() {
      setSidebarHidden(false);
    }
    function onHide() {
      setSidebarHidden(true);
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener("app:show-sidebar", onShow);
    window.addEventListener("app:hide-sidebar", onHide);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("app:show-sidebar", onShow);
      window.removeEventListener("app:hide-sidebar", onHide);
    };
  }, []);

  function openSidebar() {
    window.dispatchEvent(new CustomEvent("app:open-sidebar"));
  }
  function showSidebar() {
    window.dispatchEvent(new CustomEvent("app:show-sidebar"));
  }

  const btn =
    "grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-2)] text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all duration-200 hover:border-[var(--magenta-500)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--magenta-700)]";

  return (
    <>
      <button
        type="button"
        onClick={openSidebar}
        aria-label="Open sidebar"
        className={`${btn} md:hidden`}
      >
        <HamburgerIcon />
      </button>
      {sidebarHidden && (
        <button
          type="button"
          onClick={showSidebar}
          aria-label="Show sidebar"
          title="Tampilkan sidebar"
          className={`${btn} hidden md:grid`}
        >
          <RailIcon />
        </button>
      )}
    </>
  );
}

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function RailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
