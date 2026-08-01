"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { AdminPanelHost } from "@/components/AdminPanel/AdminPanelHost";

const SIDEBAR_MODE_KEY = "app-shell:sidebar-mode";
type SidebarMode = "full" | "hidden";

/**
 * Single shell — owns the global Sidebar so it mounts exactly once per app.
 * Mobile uses a full drawer; tablet and desktop use a persistent full sidebar
 * that the header hamburger toggles between visible and hidden.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mode, setMode] = useState<SidebarMode>("full");
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const desktop = window.matchMedia("(min-width: 768px)");
    setIsDesktop(desktop.matches);
    function onDesktopChange(e: MediaQueryListEvent) { setIsDesktop(e.matches); }
    desktop.addEventListener("change", onDesktopChange);
    return () => desktop.removeEventListener("change", onDesktopChange);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_MODE_KEY);
      const restored: SidebarMode = stored === "hidden" ? "hidden" : "full";
      setMode(restored);
      if (stored !== restored) window.localStorage.setItem(SIDEBAR_MODE_KEY, restored);
    } catch {
      /* localStorage may be blocked — keep default */
    }
  }, []);

  function persist(next: SidebarMode) {
    try {
      window.localStorage.setItem(SIDEBAR_MODE_KEY, next);
    } catch {
      /* best-effort */
    }
  }

  const setDesktopMode = (next: SidebarMode) => {
    setMode(next);
    persist(next);
  };

  const chatMatch =
    pathname?.match(/^\/chat\/(\d+)/) ||
    pathname?.match(/^\/projects\/\d+\/chat\/(\d+)/);
  const activeSessionId = chatMatch ? Number(chatMatch[1]) : null;

  useEffect(() => {
    function toggle() {
      if (isDesktop) setDesktopMode(mode === "hidden" ? "full" : "hidden");
      else setSidebarOpen((open) => !open);
    }
    function close() {
      if (isDesktop) setDesktopMode("hidden");
      else setSidebarOpen(false);
    }
    window.addEventListener("app:open-sidebar", toggle);
    window.addEventListener("app:close-sidebar", close);
    return () => {
      window.removeEventListener("app:open-sidebar", toggle);
      window.removeEventListener("app:close-sidebar", close);
    };
  }, [isDesktop, mode]);

  useEffect(() => { setSidebarOpen(false); }, [pathname]);

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
        mode={isDesktop ? mode : "full"}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
      <AdminPanelHost />
    </div>
  );
}
