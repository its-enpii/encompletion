"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";

const SIDEBAR_MODE_KEY = "app-shell:sidebar-mode";
type SidebarMode = "full" | "mini" | "hidden";

/**
 * Single shell — owns the global Sidebar so it mounts exactly once per app.
 * Layout: [dark sidebar | main content]. Main content fills remaining space.
 *
 * Mobile (below md): sidebar is treated as "full" for layout; visibility is
 * driven by the local `sidebarOpen` drawer state. The hamburger in the chat
 * header toggles the drawer via the "app:open-sidebar" event.
 *
 * Desktop (md+): the sidebar has three persistent modes:
 *  - full   : 280px wide, full text labels (default)
 *  - mini   : ~64px icon rail, labels collapsed
 *  - hidden : rail slides off-screen; chat header shows a "show sidebar"
 *             button to restore it
 *
 * Mode cycling (full ↔ mini) is driven by a button inside the sidebar.
 * Switching to/from "hidden" goes through dedicated events so other UI
 * (chat header button, keyboard shortcut) can set it without firing the
 * wrong state. The chosen mode is persisted to localStorage.
 */
export function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setModeRaw] = useState<SidebarMode>("full");

  // Track viewport so we don't push a desktop mode (mini / hidden) onto
  // a mobile render — the inner Sidebar's content uses the persisted mode
  // to decide whether to collapse labels, so leaking a desktop `mini` into
  // a mobile layout would shrink the rail to icon-only and break touch UX.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mql.matches);
    function onChange(e: MediaQueryListEvent) { setIsDesktop(e.matches); }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Restore persisted mode on mount. Falls back to "full" on missing/corrupt.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(SIDEBAR_MODE_KEY);
      if (v === "full" || v === "mini" || v === "hidden") setModeRaw(v);
    } catch {
      /* localStorage may be blocked — keep default */
    }
  }, []);

  const persist = useCallback((next: SidebarMode) => {
    try {
      window.localStorage.setItem(SIDEBAR_MODE_KEY, next);
    } catch {
      /* best-effort */
    }
  }, []);

  // Effective mode for rendering. The mobile rail is always "full" because
  // there's no horizontal room for the icon-only mini rail — touch targets
  // need labels. The persisted `mode` only matters on desktop.
  const renderMode: SidebarMode = !isDesktop ? "full" : mode;

  // Cycle full ↔ mini. "hidden" is reachable through dedicated events
  // (app:hide-sidebar, app:show-sidebar) rather than this button, so a
  // single tap doesn't accidentally slide the rail off-screen.
  const cycleMode = useCallback(() => {
    setModeRaw((cur) => {
      const next: SidebarMode = cur === "full" ? "mini" : "full";
      persist(next);
      return next;
    });
  }, [persist]);

  const setMode = useCallback(
    (next: SidebarMode) => {
      persist(next);
      setModeRaw(next);
    },
    [persist]
  );

  const chatMatch =
    pathname?.match(/^\/chat\/(\d+)/) ||
    pathname?.match(/^\/projects\/\d+\/chat\/(\d+)/);
  const activeSessionId = chatMatch ? Number(chatMatch[1]) : null;

  useEffect(() => {
    function open() { setSidebarOpen(true); }
    function closeDrawer() { setSidebarOpen(false); }
    function cycle() { cycleMode(); }
    function showSidebar() { setMode("full"); }
    function hideSidebar() { setMode("hidden"); }
    window.addEventListener("app:open-sidebar", open);
    window.addEventListener("app:close-sidebar", closeDrawer);
    window.addEventListener("app:cycle-sidebar", cycle);
    window.addEventListener("app:show-sidebar", showSidebar);
    window.addEventListener("app:hide-sidebar", hideSidebar);
    return () => {
      window.removeEventListener("app:open-sidebar", open);
      window.removeEventListener("app:close-sidebar", closeDrawer);
      window.removeEventListener("app:cycle-sidebar", cycle);
      window.removeEventListener("app:show-sidebar", showSidebar);
      window.removeEventListener("app:hide-sidebar", hideSidebar);
    };
  }, [cycleMode, setMode]);

  // Close mobile drawer whenever route changes.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <Sidebar
        activeSessionId={activeSessionId}
        onSelectSession={(s) => router.push(`/chat/${s.id}`)}
        onNewChat={() => router.push("/new")}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        mode={renderMode}
        onCycleMode={cycleMode}
      />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
