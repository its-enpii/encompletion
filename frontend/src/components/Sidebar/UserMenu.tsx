"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pill } from "@/components/ui/Pill";

export type AuthUser = {
  username: string;
  display_name?: string | null;
  role: "admin" | "member";
};

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
          className="anim-scale-in absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-[var(--r-md)] border border-[var(--line-dark)] bg-[var(--dark-2)] py-1 shadow-[var(--shadow-4)]"
        >
          {/* Profile header */}
          <div className="border-b border-[var(--dark-4)] bg-[var(--dark-3)]/50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--dark-text-3)]">Signed in as</div>
            <div className="mt-0.5 truncate text-sm font-medium text-[var(--dark-text)]">
              {user.display_name || user.username}
            </div>
          </div>

          {isAdmin && (
            <Item
              icon={<UsersIcon className="h-3.5 w-3.5" />}
              label="Users"
              onClick={() => { setOpen(false); router.push("/users"); }}
            />
          )}
          <Item
            icon={<FolderIcon className="h-3.5 w-3.5" />}
            label="Projects"
            onClick={() => { setOpen(false); router.push("/projects"); }}
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
function FolderIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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