"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { BrandMark } from "@/components/ui/BrandMark";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user && pathname !== "/login") {
      router.push("/login");
    } else if (user && pathname === "/login") {
      router.push("/");
    }
  }, [user, loading, pathname, router]);

  if (loading) {
    return (
      <div className="grid min-h-screen w-screen place-items-center bg-[var(--paper)]">
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