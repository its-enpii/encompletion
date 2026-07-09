"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import type { PendingAtt } from "./types";

/**
 * Content-aware preview tile for a pending attachment.
 *
 * - image/*    → actual image preview
 * - text/markdown, .md → rendered Markdown (truncated to ~1.2k chars)
 * - text/*     → monospace text preview
 * - code-like  → syntax-highlighted code (via highlight.js through react-markdown)
 * - everything else → generic file icon + name + size
 *
 * Click the header / "show more" toggle on long previews to expand collapsed
 * content; click the × to remove. The whole tile never blocks Composer input
 * because it's a sibling, not a modal.
 */
export function AttachmentTile({
  att,
  onRemove,
}: {
  att: PendingAtt;
  onRemove: () => void;
}) {
  const kind = classify(att);
  const [expanded, setExpanded] = useState(false);

  // Long-text previews collapse by default; toggle to read the rest.
  const TEXT_CAP = 1200;
  const text = kind.kind === "text" || kind.kind === "code" || kind.kind === "markdown"
    ? decodeDataUrl(att.content)
    : "";
  const truncated = text.length > TEXT_CAP;
  const shownText = truncated && !expanded ? text.slice(0, TEXT_CAP) : text;

  return (
    <div
      className="group/att relative flex w-44 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-2)]"
      title={att.file_name}
    >
      {/* Preview area — type-specific */}
      <div className="relative h-28 w-full overflow-hidden bg-[var(--paper-2)]">
        {kind.kind === "image" && (
          <img
            src={att.content}
            alt={att.file_name}
            className="h-full w-full object-cover"
            draggable={false}
          />
        )}
        {kind.kind === "markdown" && (
          <div className="h-full w-full overflow-hidden p-2 text-[10px] leading-snug">
            <div className="line-clamp-[8] text-[var(--ink-2)]">
              <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={mdComponents}>
                {shownText || "_(empty)_"}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {kind.kind === "code" && (
          <pre className="dark-scroll h-full w-full overflow-hidden p-2 font-mono text-[10px] leading-snug text-[var(--ink-2)]">
            <code className={`language-${kind.lang}`}>{shownText || "\n"}</code>
          </pre>
        )}
        {kind.kind === "text" && (
          <div className="h-full w-full overflow-hidden p-2 font-mono text-[10px] leading-snug text-[var(--ink-2)]">
            {shownText}
          </div>
        )}
        {kind.kind === "generic" && (
          <div className="flex h-full w-full items-center justify-center">
            <KindBadge kind={kind} />
          </div>
        )}
        {truncated && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="absolute bottom-1 right-1 rounded-full bg-[var(--paper)]/85 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--ink-2)] shadow-[var(--shadow-1)] backdrop-blur transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            {expanded ? "collapse" : "show more"}
          </button>
        )}
      </div>

      {/* Footer — name + size + remove */}
      <div className="flex items-center gap-1.5 border-t border-[var(--line)] bg-[var(--paper)] px-2 py-1.5">
        <KindBadge kind={kind} compact />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--ink-2)]">
          {att.file_name}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--ink-3)]">
          {formatSize(att.size)}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove attachment"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--ink-3)] transition-colors hover:bg-[var(--danger-50)] hover:text-[var(--danger)]"
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ----- Classification ----- */

type Kind =
  | { kind: "image"; ext: string }
  | { kind: "markdown"; ext: string }
  | { kind: "code"; ext: string; lang: string }
  | { kind: "text"; ext: string }
  | { kind: "generic"; ext: string };

const CODE_EXTS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
  html: "html", htm: "html", css: "css", json: "json", yaml: "yaml",
  yml: "yaml", toml: "ini", ini: "ini", vue: "html", svelte: "html",
};

function classify(att: PendingAtt): Kind {
  const name = att.file_name || "";
  const dot = name.lastIndexOf(".");
  const ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
  const mt = (att.mime_type || "").toLowerCase();

  if (mt.startsWith("image/")) return { kind: "image", ext };
  if (ext === "md" || mt === "text/markdown") return { kind: "markdown", ext };
  if (CODE_EXTS[ext]) return { kind: "code", ext, lang: CODE_EXTS[ext] };
  if (mt.startsWith("text/")) return { kind: "text", ext };

  return { kind: "generic", ext };
}

/* ----- Kind badge (footer icon + fallback preview) ----- */

function KindBadge({ kind, compact = false }: { kind: Kind; compact?: boolean }) {
  const cfg = badgeConfig(kind);
  const size = compact ? "h-4 w-4 text-[8px]" : "h-12 w-12 text-base";
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-[var(--r-sm)] font-bold uppercase tracking-wider ${size}`}
      style={{ background: cfg.bg, color: cfg.fg }}
      aria-hidden
    >
      {cfg.label}
    </span>
  );
}

function badgeConfig(kind: Kind): { bg: string; fg: string; label: string } {
  if (kind.kind === "image") return { bg: "var(--saffron-50)", fg: "var(--saffron-700)", label: "IMG" };
  if (kind.kind === "markdown") return { bg: "var(--magenta-50)", fg: "var(--magenta-700)", label: "MD" };
  if (kind.kind === "code") return { bg: "rgba(14,165,233,0.10)", fg: "#0369A1", label: ".TSX".slice(0, 4) };
  if (kind.kind === "text") return { bg: "var(--ink-2)", fg: "var(--paper)", label: "TXT" };
  // generic — show extension badge
  return { bg: "var(--paper-3)", fg: "var(--ink-3)", label: kind.ext.slice(0, 4).toUpperCase() || "FILE" };
}

/* ----- Markdown rendering tweaks (tight, no big headings) ----- */

const mdComponents = {
  h1: (p: React.HTMLAttributes<HTMLHeadingElement>) => <p className="text-[10px] font-bold" {...p} />,
  h2: (p: React.HTMLAttributes<HTMLHeadingElement>) => <p className="text-[10px] font-bold" {...p} />,
  h3: (p: React.HTMLAttributes<HTMLHeadingElement>) => <p className="font-bold" {...p} />,
  p:  (p: React.HTMLAttributes<HTMLParagraphElement>) => <p className="my-0.5" {...p} />,
  ul: (p: React.HTMLAttributes<HTMLUListElement>) => <ul className="my-0.5 ml-3 list-disc" {...p} />,
  ol: (p: React.HTMLAttributes<HTMLOListElement>) => <ol className="my-0.5 ml-3 list-decimal" {...p} />,
  pre: (p: React.HTMLAttributes<HTMLPreElement>) => <pre className="my-1 overflow-hidden rounded bg-black/30 p-1 font-mono text-[9px]" {...p} />,
  code: (p: React.HTMLAttributes<HTMLElement>) => <code className="rounded bg-black/20 px-0.5 font-mono" {...p} />,
  img: (p: React.ImgHTMLAttributes<HTMLImageElement>) => null, // hide images inside markdown preview to keep tile compact
  a:  (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a className="text-[var(--magenta-600)]" {...p} />,
};

/* ----- Helpers ----- */

function decodeDataUrl(d?: string): string {
  if (!d) return "";
  // PendingAtt.content is a data URL (data:<mime>;base64,<payload>); the read
  // path goes through FileReader.readAsDataURL. Strip prefix + base64-decode
  // for text/* kinds. Binary kinds don't need text decoding here.
  const m = d.match(/^data:[^;]+;base64,(.+)$/);
  if (!m) return "";
  try {
    return atob(m[1]);
  } catch {
    return "";
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}
