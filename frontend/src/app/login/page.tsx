"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { Card } from "@/components/ui/Card";
import { BrandMark } from "@/components/ui/BrandMark";

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // AuthGate sends unauthenticated users here with `?next=/some/path`.
  // After a successful login we bounce them back to where they were
  // heading instead of always landing on the home page. The fallback
  // stays "/" so a manual visit to /login still works.
  const nextPath = (() => {
    const n = searchParams?.get("next");
    if (!n) return "/";
    // Defence against open-redirect: only allow same-origin, leading "/",
    // no scheme or host. Anything else falls back to home.
    if (!n.startsWith("/") || n.startsWith("//")) return "/";
    return n;
  })();
  // Empty by default — we used to prefill 'admin' here as a UX shortcut, but
  // that advertises the seed admin role to anyone who opens /login. The
  // field's placeholder still nudges users toward a username format.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const ok = await login(username, password);
    setLoading(false);
    if (ok) router.push(nextPath);
    else setErr("Username atau password salah");
  }

  return (
    <div className="grid min-h-screen w-screen lg:grid-cols-2">
      {/* Left: visual panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-[var(--dark)] p-12 text-[var(--dark-text)] lg:flex">
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-40">
          <div className="absolute -left-20 top-1/4 h-72 w-72 rounded-full bg-[var(--magenta-700)] blur-[100px]" />
          <div className="absolute -right-20 bottom-1/4 h-80 w-80 rounded-full bg-[var(--saffron-500)] blur-[120px]" />
        </div>

        {/* Grid pattern overlay */}
        <svg className="absolute inset-0 h-full w-full opacity-[0.05]" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" className="text-white" />
        </svg>

        {/* Top: brand */}
        <div className="relative">
          <BrandMark size="lg" tone="dark" />
        </div>

        {/* Middle: marketing copy */}
        <div className="relative space-y-6">
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--saffron-200)]">
              Encompletion · Web GUI
            </span>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight">
              Chat langsung dari browser.
            </h1>
          </div>

          <p className="max-w-md text-[15px] leading-relaxed text-[var(--dark-text-2)]">
            Streaming responses, project-aware instructions, skill management, dan artifact rendering —
            semua tanpa meninggalkan UI yang kamu buka sekarang.
          </p>

          <div className="space-y-3 pt-4">
            <Feature
              icon="stream"
              title="Real-time streaming"
              subtitle="Lihat jawaban terbentuk token demi token"
            />
            <Feature
              icon="folder"
              title="Project context"
              subtitle="Knowledge & instructions otomatis ter-inject ke prompt"
            />
            <Feature
              icon="terminal"
              title="Tool transparency"
              subtitle="Setiap Bash, Read, dan Edit terlihat jelas di panel"
            />
          </div>
        </div>

        {/* Bottom: footer */}
        <div className="relative flex items-center justify-between border-t border-[var(--line-dark)] pt-6 text-[11px] text-[var(--dark-text-3)]">
          <div className="flex items-center gap-2">
            <span className="grid h-1.5 w-1.5 place-items-center rounded-full bg-[var(--success)]">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-[var(--success)] opacity-75" />
            </span>
            <span>All systems operational</span>
          </div>
          <span>Enpii Studio · v1</span>
        </div>
      </div>

      {/* Right: form */}
      <div className="grid place-items-center bg-[var(--paper)] p-6 lg:p-12">
        <div className="w-full max-w-sm">
          {/* Mobile-only brand */}
          <div className="mb-8 lg:hidden">
            <BrandMark size="lg" />
          </div>

          <div className="mb-6 hidden lg:block">
            <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">
              Welcome back
            </h2>
            <p className="mt-1 text-sm text-[var(--ink-3)]">
              Sign in untuk mulai sesi.
            </p>
          </div>

          <Card className="overflow-hidden">
            <form onSubmit={submit}>
              <div className="space-y-4 px-6 py-6">
                <TextField
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  required
                />
                <TextField
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />

                {err && (
                  <div className="flex items-start gap-2 rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)] anim-fade-in">
                    <svg viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{err}</span>
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--line)] bg-[var(--paper-2)] px-6 py-4">
                <Button
                  type="submit"
                  variant="primary"
                  className="w-full"
                  disabled={loading}
                  size="lg"
                >
                  {loading ? (
                    <>
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      <span>Signing in…</span>
                    </>
                  ) : (
                    <>
                      <span>Sign in</span>
                      <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Feature({
  icon,
  title,
  subtitle,
}: {
  icon: "stream" | "folder" | "terminal";
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--line-dark)] bg-[var(--dark-2)]/50 p-3 backdrop-blur-sm">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--saffron-500)]/15 text-[var(--saffron-200)] ring-1 ring-inset ring-[var(--saffron-500)]/20">
        <FeatureIcon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[var(--dark-text)]">{title}</div>
        <div className="mt-0.5 text-xs text-[var(--dark-text-3)]">{subtitle}</div>
      </div>
    </div>
  );
}

function FeatureIcon({ name, ...props }: { name: "stream" | "folder" | "terminal" } & React.SVGProps<SVGSVGElement>) {
  if (name === "stream") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>;
  if (name === "folder") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
}