"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui/Pill";

export type AuthUser = {
  username: string;
  display_name?: string | null;
  role: "admin" | "member";
};

/**
 * Tiny dispatcher wrapper. The menu items don't navigate to /users
 * etc. — admin surfaces are now fullscreen overlays surfaced via
 * window events listened to by AdminPanelHost. This avoids Route
 * changes (which would close/reopen AppShell-mounted tree and
 * restart scroll/animation state in the sidebar).
 */
function openAdmin(eventName: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(eventName));
  }
}

export function UserMenu({ user, onLogout, collapsed = false }: { user: AuthUser; onLogout: () => void; collapsed?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = (user.display_name || user.username).slice(0, 2).toUpperCase();
  const isAdmin = user.role === "admin";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={collapsed ? user.username : undefined}
        className={`group flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 py-1.5 transition-all ${
          collapsed ? "md:justify-center md:px-0" : ""
        } ${
          open
            ? "bg-[var(--dark-3)] shadow-[inset_0_0_0_1px_var(--dark-4)]"
            : "hover:bg-[var(--dark-2)]"
        }`}
      >
        <span
          className={`relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold shadow-[var(--shadow-1)] ring-2 ${
            isAdmin
              ? "bg-gradient-to-br from-[var(--saffron-200)] to-[var(--saffron-500)] text-[var(--ink)] ring-[var(--saffron-300)]/40"
              : "bg-gradient-to-br from-[var(--magenta-400)] to-[var(--magenta-700)] text-white ring-[var(--magenta-300)]/40"
          }`}
          aria-hidden="true"
        >
          <span className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent" />
          <span className="relative">{initials}</span>
        </span>
        <span className={`flex min-w-0 flex-1 flex-col items-start text-left ${collapsed ? "md:hidden" : ""}`}>
          <span className="w-full truncate text-sm font-semibold text-[var(--dark-text)]">
            {user.display_name || user.username}
          </span>
          <span className="w-full truncate text-[11px] text-[var(--dark-text-3)]">@{user.username}</span>
        </span>
        <span className={collapsed ? "md:hidden" : ""}>
          <Pill tone={isAdmin ? "saffron" : "neutral"}>{user.role}</Pill>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={`anim-scale-in absolute bottom-0 mb-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--line-dark)] bg-[var(--dark-2)] py-1 shadow-[var(--shadow-4)] ${
            collapsed ? "left-full ml-2 w-64" : "left-0 right-0"
          }`}
        >
          {/* Profile header */}
          <div className="border-b border-[var(--dark-4)] bg-[var(--dark-3)]/50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--dark-text-3)]">Signed in as</div>
            <div className="mt-0.5 truncate text-sm font-medium text-[var(--dark-text)]">
              {user.display_name || user.username}
            </div>
          </div>

          {/* Admin group — only visible to admins */}
          {isAdmin && (
            <>
              <GroupLabel label="Admin" />
              <Item
                icon={<UsersIcon className="h-3.5 w-3.5" />}
                label="Users"
                onClick={() => { setOpen(false); openAdmin("admin:open-users"); }}
              />
              <Item
                icon={<CpuIcon className="h-3.5 w-3.5" />}
                label="Models"
                onClick={() => { setOpen(false); openAdmin("admin:open-models"); }}
              />
              <Item
                icon={<EmbedIcon className="h-3.5 w-3.5" />}
                label="Embed tenants"
                onClick={() => { setOpen(false); openAdmin("admin:open-embed"); }}
              />
            </>
          )}

          {/* Account group — visible to everyone */}
          <GroupLabel label="Account" />
          <Item
            icon={<KeyIcon className="h-3.5 w-3.5" />}
            label="API Keys"
            onClick={() => { setOpen(false); openAdmin("admin:open-api-keys"); }}
          />
          <Item
            icon={<BrainIcon className="h-3.5 w-3.5" />}
            label="Memory"
            onClick={() => { setOpen(false); openAdmin("admin:open-memory"); }}
          />
          <Item
            icon={<PromptIcon className="h-3.5 w-3.5" />}
            label="System Prompt"
            onClick={() => { setOpen(false); openAdmin("admin:open-prompt"); }}
          />
          <div className="my-1 mx-2 border-t border-[var(--dark-4)]" />
          <Item
            icon={<LogoutIcon className="h-3.5 w-3.5" />}
            label="Logout"
            danger
            onClick={() => { setOpen(false); onLogout(); }}
          />
        </div>
      )}
    </div>
  );
}

function GroupLabel({ label }: { label: string }) {
  return (
    <div className="mx-3 mt-1.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--dark-text-3)]">
      {label}
    </div>
  );
}

function Item({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors ${
        danger
          ? "text-[var(--danger)] hover:bg-[var(--danger-50)]/10"
          : "text-[var(--dark-text-2)] hover:bg-[var(--dark-3)] hover:text-[var(--dark-text)]"
      }`}
    >
      <span className={danger ? "text-current" : "text-[var(--saffron-200)]"}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function UsersIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  );
}
function CpuIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}
function EmbedIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function KeyIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.85 12.15 8.65-8.65" /><path d="m18 5 2 2" /><path d="m15 8 2 2" />
    </svg>
  );
}
function PromptIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="14" y2="13" />
    </svg>
  );
}
function BrainIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 1 1-5 0V18a2.5 2.5 0 0 1-2.5-2.5 2.5 2.5 0 0 1-2-4 2.5 2.5 0 0 1 0-4 2.5 2.5 0 0 1 2-4A2.5 2.5 0 0 1 7 4.5V4.5A2.5 2.5 0 0 1 9.5 2z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 1 0 5 0V18a2.5 2.5 0 0 0 2.5-2.5 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 0 0-4 2.5 2.5 0 0 0-2-4A2.5 2.5 0 0 0 17 4.5V4.5A2.5 2.5 0 0 0 14.5 2z" />
    </svg>
  );
}
function LogoutIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}