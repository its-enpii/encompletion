/**
 * Onboarding layout — minimal chrome so the first-run screen doesn't
 * flash the chat sidebar before the user has configured their LLM.
 * Lives outside /(main) so AppShell doesn't mount.
 */
export default function OnboardingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}