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

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);

    const t = setTimeout(() => {
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
  }, [open, onClose]);

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
      onMouseDown={(e) => {
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
          <header className="border-b border-[var(--line)] px-6 py-4">
            {title && (
              <h2 className="text-base font-semibold tracking-tight text-[var(--ink)]">{title}</h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-[var(--ink-2)]">{description}</p>
            )}
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
