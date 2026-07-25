"use client";

import { useState, type JSX } from "react";

type Props = {
  artifact: {
    id: number;
    type: string;
    language: string | null;
    title: string | null;
    content_preview: string;
    line_count: number;
  };
  onOpen: () => void;
};

const TYPE_META: Record<string, { label: string; color: string; bg: string; icon: JSX.Element }> = {
  html:      { label: "HTML",  color: "var(--saffron-700)",  bg: "var(--saffron-50)", icon: <HtmlGlyph /> },
  jsx:       { label: "JSX",   color: "#0EA5E9",             bg: "rgba(14,165,233,0.10)", icon: <CodeGlyph /> },
  react:     { label: "React", color: "#06B6D4",             bg: "rgba(6,182,212,0.10)", icon: <ReactGlyph /> },
  svg:       { label: "SVG",   color: "#8B5CF6",             bg: "rgba(139,92,246,0.10)", icon: <SvgGlyph /> },
  markdown:  { label: "MD",    color: "var(--ink-2)",         bg: "var(--paper-2)",       icon: <MdGlyph /> },
  code:      { label: "Code",  color: "var(--ink-2)",         bg: "var(--paper-2)",       icon: <CodeGlyph /> },
};

/**
 * Inline artifact card rendered directly under the assistant message
 * that produced it. Click the card body or the "Buka" button to open
 * the full ArtifactViewerDialog with rendering / code tabs.
 */
export function ArtifactCard({ artifact, onOpen }: Props) {
  const meta = TYPE_META[artifact.type] ?? TYPE_META.code;
  const display = artifact.title || `Untitled ${meta.label}`;
  const [hovered, setHovered] = useState(false);

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group/card anim-slide-up flex w-full items-stretch overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] text-left shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-2)]"
    >
      <span
        className="grid w-12 shrink-0 place-items-center"
        style={{ background: meta.bg, color: meta.color }}
        aria-hidden
      >
        {meta.icon}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{display}</span>
            <span className="shrink-0 rounded-full bg-[var(--paper-2)] px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase tracking-[0.04em] text-[var(--ink-3)] ring-1 ring-inset ring-[var(--line)]">
              {meta.label}
            </span>
            {artifact.language && artifact.language !== artifact.type && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--ink-3)]">{artifact.language}</span>
            )}
          </div>
          <div className="mt-0.5 line-clamp-1 font-mono text-[11px] text-[var(--ink-3)]">
            {artifact.content_preview}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-[var(--ink-3)]">{artifact.line_count} baris</span>
          <span
            className={`grid h-7 w-7 place-items-center rounded-[var(--r-sm)] text-[var(--ink-2)] transition-all ${
              hovered ? "bg-[var(--magenta-50)] text-[var(--magenta-700)]" : "bg-[var(--paper-2)]"
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        </span>
      </div>
    </button>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function HtmlGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 8 7 12 17" /><polyline points="6 13 10 13" />
      <line x1="14" y1="7" x2="20" y2="17" /><line x1="20" y1="7" x2="14" y2="17" />
    </svg>
  );
}
function ReactGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}
function SvgGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
function MdGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 16V10l2 2 2-2v6" />
      <path d="M14 10v6m0 0l-2-2m2 2l2-2" />
    </svg>
  );
}
