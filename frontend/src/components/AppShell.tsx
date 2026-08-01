"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { AdminPanelHost } from "@/components/AdminPanel/AdminPanelHost";

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
  const [isWide, setIsWide] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const desktop = window.matchMedia("(min-width: 768px)");
    const wide = window.matchMedia("(min-width: 1280px)");
    setIsDesktop(desktop.matches);
    setIsWide(wide.matches);
    function onDesktopChange(e: MediaQueryListEvent) { setIsDesktop(e.matches); }
    function onWideChange(e: MediaQueryListEvent) { setIsWide(e.matches); }
    desktop.addEventListener("change", onDesktopChange);
    wide.addEventListener("change", onWideChange);
    return () => {
      desktop.removeEventListener("change", onDesktopChange);
      wide.removeEventListener("change", onWideChange);
    };
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
  // Effective mode for rendering.
  //   - mobile (<768): always "full" so the drawer has real labels.
  //   - tablet (768-1279): always "full" — collapsing to a 64px icon rail
  //     squeezes the chat column too much on common tablet widths
  //     (800-1024) and leaves no way to surface the session list.
  //   - xl+: honor the persisted mode (full/mini/hidden) so the user
  //     can collapse the rail when they need a wider chat.
  const renderMode: SidebarMode = isWide ? mode : "full";

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

  // h-dvh: mobile Chrome address bar; h-screen (100vh) overshoots.
  return (
    <div className="flex h-dvh w-full max-w-[100vw] overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
      <Sidebar
        activeSessionId={activeSessionId}
        onSelectSession={(s) => {
          if (s.project_id) router.push(`/projects/${s.project_id}/chat/${s.id}`);
          else router.push(`/chat/${s.id}`);
        }}
        onNewChat={() => router.push("/new")}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        mode={renderMode}
        onCycleMode={cycleMode}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
      {/* Admin overlays — render nothing until dispatched via window
          events from UserMenu. Lives in AppShell so it stays mounted
          across navigations; AdminPanelHost closes itself on route
          change. */}
      <AdminPanelHost />
    </div>
  );
}
