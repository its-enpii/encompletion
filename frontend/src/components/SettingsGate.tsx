"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useLlmSettings } from "@/lib/llmSettings";
import { BrandMark } from "@/components/ui/BrandMark";

/**
 * SettingsGate — wraps children inside AuthGate. Once auth resolves, it
 * checks whether the user has configured their LLM endpoint. If not, it
 * redirects to /onboarding/llm so the new user can paste their
 * base_url + api_key before they're allowed into the chat shell.
 *
 * Logic:
 *   - AuthGate handles the !user → /login redirect; we only see
 *     authenticated users here.
 *   - If user is present and configured=false and pathname is not
 *     /login or /onboarding/llm, redirect to /onboarding/llm.
 *   - On /onboarding/llm we let the page render; the page handles its
 *     own submit + post-save redirect.
 *   - We DO NOT block on `loading`: while /api/auth/me is in flight,
 *     show the spinner via AuthGate. Once /me resolves, refresh() in
 *     the provider populates `configured` and we re-render.
 */
export default function SettingsGate({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { llm, loading: llmLoading } = useLlmSettings();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (authLoading || llmLoading) return;
    if (!user) return; // AuthGate handles unauthenticated redirects.
    const onOnboarding = pathname === "/onboarding/llm";
    const onLogin = pathname === "/login";
    if (!llm.configured && !onOnboarding && !onLogin) {
      router.replace("/onboarding/llm");
    }
  }, [user, authLoading, llm.configured, llmLoading, pathname, router]);

  // Hold the spinner while we either don't have auth OR we have auth
  // but haven't yet determined `configured`. Once `configured` is
  // known, render children (or stay on /onboarding/llm where the page
  // takes over).
  const waiting = authLoading || llmLoading || (!!user && llm.configured === false && pathname !== "/onboarding/llm" && pathname !== "/login");

  if (waiting) {
    return (
      <div className="grid min-h-dvh w-full max-w-[100vw] place-items-center bg-[var(--paper)]">
        <div className="flex flex-col items-center gap-5">
          <BrandMark size="lg" />
          <div className="flex items-center gap-2 text-sm text-[var(--ink-3)]">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--magenta)]" />
            <span>Memuat…</span>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}