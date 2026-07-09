"use client";

import { useEffect } from "react";

type Kind = "info" | "success" | "error";

export type ToastItem = {
  id: number;
  kind: Kind;
  message: string;
};

const TOAST_TTL_MS = 4500;

const palette: Record<Kind, { box: string; glyph: string; glyphBg: string; glyphColor: string }> = {
  info: {
    box: "border-[var(--line)] bg-[var(--paper-3)] text-[var(--ink)]",
    glyph: "i",
    glyphBg: "bg-[var(--magenta)]",
    glyphColor: "text-white",
  },
  success: {
    box: "border-[#B6DCC4] bg-[var(--success-50)] text-[var(--success)]",
    glyph: "✓",
    glyphBg: "bg-[var(--success)]",
    glyphColor: "text-white",
  },
  error: {
    box: "border-[#EFB5B5] bg-[var(--danger-50)] text-[var(--danger)]",
    glyph: "!",
    glyphBg: "bg-[var(--danger)]",
    glyphColor: "text-white",
  },
};

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[210] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const tm = setTimeout(() => onDismiss(toast.id), TOAST_TTL_MS);
    return () => clearTimeout(tm);
  }, [toast.id, onDismiss]);

  const p = palette[toast.kind];

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      style={{ animation: "toast-in 220ms var(--ease-spring)" }}
      className={`pointer-events-auto flex items-start gap-3 rounded-[var(--r-md)] border px-3.5 py-3 text-sm shadow-[var(--shadow-3)] ${p.box}`}
    >
      <span
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${p.glyphBg} ${p.glyphColor}`}
        aria-hidden="true"
      >
        {p.glyph}
      </span>
      <span className="flex-1 break-words leading-snug">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-xs opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
