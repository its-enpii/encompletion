"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type CenteredDialogProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  widthClass?: string;
  hideHeader?: boolean;
  footer?: React.ReactNode;
  children?: React.ReactNode;
};

/**
 * Single source of modal shell. Portals into document.body. Focus traps,
 * ESC closes, body scroll locks, restores focus on unmount.
 */
export function CenteredDialog({
  open,
  onClose,
  title,
  description,
  widthClass = "max-w-md",
  hideHeader = false,
  footer,
  children,
}: CenteredDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Stable ref to onClose so ESC and the body-scroll lock don't tear down
  // every parent re-render — that was the cause of focus-jumping-to-key
  // bugs in mobile keyboards. We always read the latest onClose from the
  // ref at call time, so behaviour tracks props without re-binding.
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

    // Only autofocus the first field on the *initial* open transition. If
    // the parent re-renders (form value typing → setState), this effect's
    // deps don't change, so we don't yank focus back to the first input
    // on every keystroke — which is exactly the bug on mobile keyboards
    // where typing in the Label field kept snapping focus back to Key.
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
      className="anim-fade-in fixed inset-0 z-[200] flex items-center justify-center bg-[#1A1410]/40 p-4 backdrop-blur-sm"
      // Close on backdrop click. Use `pointerdown` so we catch both mouse
      // and touch, and use capture phase so we run before anything inside
      // the dialog can stop propagation. Compare against currentTarget —
      // not target — because a child element swallows the event target,
      // but `currentTarget` is always the element we attached the
      // handler to (the backdrop).
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
        className={`card anim-scale-in w-full overflow-hidden ${widthClass} max-h-[90vh] shadow-[var(--shadow-4)] outline-none`}
      >
        {!hideHeader && (title || description) && (
          <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-4">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 className="text-base font-semibold tracking-tight text-[var(--ink)]">{title}</h2>
              )}
              {description && (
                <p className="mt-1 text-sm text-[var(--ink-2)]">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              title="Close (Esc)"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-sm)] text-[var(--ink-3)] transition hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </header>
        )}
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] bg-[var(--paper-2)] px-6 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    portalNode
  );
}
