import { AppShell } from "@/components/AppShell";

/**
 * Chrome for every authenticated page. Living in a Next.js route
 * group means the layout (and therefore the global Sidebar) mounts
 * exactly once across navigations within /(main) — chat → settings
 * → projects no longer remount the Sidebar, so its in-memory
 * `sessions` state survives and we don't flash a skeleton between
 * pages. /login stays outside the group so the unauthenticated
 * screen has no sidebar chrome.
 */
export default function MainLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
