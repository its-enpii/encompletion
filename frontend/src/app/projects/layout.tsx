export default function ProjectsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // No layout chrome — every page in /projects* renders its own
  // <AppShell>, which mounts the single global Sidebar exactly once.
  return <>{children}</>;
}