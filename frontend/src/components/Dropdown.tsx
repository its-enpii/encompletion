"use client";

import { useEffect, useRef, useState } from "react";

type Option = {
  value: string;
  label: React.ReactNode;
  color?: string;
};

type Props = {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  renderSelected?: (opt: Option | undefined) => React.ReactNode;
  className?: string;
  title?: string;
  triggerClass?: string;
  caption?: string;
  direction?: "up" | "down";
  disabled?: boolean;
  /** sm = compact (h-8), md = form field (h-10, matches .input). */
  size?: "sm" | "md";
};

/**
 * Custom themed dropdown — no native OS select chrome.
 * Keyboard: ↑/↓/Enter/Esc, type-ahead first letter.
 */
export default function Dropdown({
  value,
  onChange,
  options,
  renderSelected,
  className = "",
  title,
  triggerClass = "",
  caption,
  direction = "down",
  disabled = false,
  size = "md",
}: Props) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setFocusIdx(idx >= 0 ? idx : 0);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function onKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Escape") {
      setOpen(false);
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (!open) setOpen(true);
      else if (options[focusIdx]) {
        onChange(options[focusIdx].value);
        setOpen(false);
      }
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      setFocusIdx((i) => (i + 1) % options.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setFocusIdx((i) => (i - 1 + options.length) % options.length);
      e.preventDefault();
    } else if (e.key === "Home") {
      setFocusIdx(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setFocusIdx(options.length - 1);
      e.preventDefault();
    } else if (/^[a-zA-Z0-9]$/.test(e.key)) {
      const lower = e.key.toLowerCase();
      const next = options.findIndex(
        (o) =>
          String(o.value).toLowerCase().startsWith(lower) ||
          String(o.label).toLowerCase().startsWith(lower)
      );
      if (next >= 0) setFocusIdx(next);
    }
  }

  const sizeCls =
    size === "sm"
      ? "h-8 px-3 text-xs"
      : "h-10 px-3.5 text-sm shadow-[var(--shadow-1)]";

  return (
    <div
      ref={wrapRef}
      className={`relative min-w-0 ${className}`}
      onKeyDown={onKey}
    >
      <button
        type="button"
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] font-medium text-[var(--ink-2)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)] focus:border-[var(--magenta)] focus:outline-none focus:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-50 ${sizeCls} ${triggerClass}`}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {renderSelected
            ? renderSelected(selected)
            : (selected?.label ?? value)}
        </span>
        <svg
          viewBox="0 0 24 24"
          className={`h-3 w-3 shrink-0 text-[var(--ink-3)] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {caption && (
        <span className="pointer-events-none absolute -top-2 left-2 rounded bg-[var(--paper-3)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--ink-3)] ring-1 ring-[var(--line)]">
          {caption}
        </span>
      )}
      {open && !disabled && (
        <ul
          role="listbox"
          className={`anim-scale-in absolute left-0 z-50 max-h-64 min-w-full overflow-auto rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] py-1 shadow-[var(--shadow-4)] ${
            direction === "down" ? "top-full mt-1" : "bottom-full mb-1"
          }`}
        >
          {options.map((o, i) => {
            const active = o.value === value;
            const focused = i === focusIdx;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setFocusIdx(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] transition-colors ${
                  focused
                    ? "bg-[var(--magenta-50)] text-[var(--magenta-700)]"
                    : active
                      ? "bg-[var(--paper-2)] text-[var(--ink)]"
                      : "text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                }`}
              >
                {o.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full ring-1 ring-[var(--line)]"
                    style={{ background: o.color }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {active && (
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5 shrink-0 text-[var(--magenta-600)]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
