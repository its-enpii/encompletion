"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type FullscreenOverlayProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /**
   * Slotted in the header next to the close button — typically a small
   * primary CTA like "Tambah user" or a filter pill row. Width is
   * constrained so the header doesn't grow unbounded.
   */
  headerActions?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * Width class. Defaults to max-w-6xl because most admin panels
   * (users table, models grid) want the full width. Tighter dialogs
   * can pass max-w-3xl etc.
   */
  widthClass?: string;
};

/**
 * Fullscreen overlay — wide modal shell for admin panels.
 *
 * Why not CenteredDialog: CenteredDialog is sized for forms (max-w-md).
 * Users/Models/Embed admin need stat tiles + tables/grids that need
 * real width. We give them up to 6xl (~72rem) while keeping them
 * visually distinct from a full page (90vh max, backdrop, ESC).
 *
 * Mirrors CenteredDialog's focus trap + ESC + body-scroll-lock +
 * restore-focus semantics so a consumer doesn't need to know which
 * shell it's using.
 */
export function FullscreenOverlay({
  open,
  onClose,
  title,
  subtitle,
  headerActions,
  children,
  widthClass = "max-w-6xl",
}: FullscreenOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Stable ref so ESC + body-scroll-lock don't tear down every parent
  // re-render — same pattern as CenteredDialog.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", onKey);

    let didFocus = false;
    const t = setTimeout(() => {
      if (didFocus) return;
      didFocus = true;
      const el = dialogRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button, [tabindex]:not([tabindex='-1'])"
      );
      (el ?? dialogRef.current)?.focus();
    }, 30);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortalNode(document.body); }, []);

  if (!open || !portalNode) return null;

  return createPortal(
    <div
      className="anim-fade-in fixed inset-0 z-[200] flex items-center justify-center bg-[#1A1410]/50 p-4 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={`card anim-scale-in flex h-[90vh] w-full flex-col overflow-hidden ${widthClass} shadow-[var(--shadow-4)] outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] bg-[var(--paper)] px-6 py-4">
          <div className="min-w-0 flex-1">
            {title && (
              <h2 className="truncate text-base font-semibold tracking-tight text-[var(--ink)]">{title}</h2>
            )}
            {subtitle && (
              <p className="mt-1 text-sm text-[var(--ink-2)]">{subtitle}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close (Esc)"
              className="grid h-7 w-7 place-items-center rounded-[var(--r-sm)] text-[var(--ink-3)] transition hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    portalNode
  );
}