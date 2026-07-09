"use client";

import { useMemo, useRef, useState } from "react";

/**
 * Wraps a codeblock with a soft header (language badge + filename + copy)
 * and an eye-friendly code area. Receives the rendered <code> children from
 * react-markdown, which already contains the highlight.js spans — copying
 * the visible text strips those spans down to the raw source.
 */
export function CodeBlock({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement | null>(null);

  // Extract language from `language-xyz` added by rehype-highlight.
  const lang = (() => {
    const m = (className || "").match(/language-(\w+)/);
    return m ? m[1] : "";
  })();

  // Extract inline filename if the assistant wrote a "title: foo.ts" comment
  // on the first line — common with Claude when generating project files.
  const inferredFile = useMemo(() => {
    const txt = codeRef.current?.textContent || "";
    const m =
      txt.match(/^\/\/\s*([\w./-]+\.\w+)/) ||
      txt.match(/^#\s*([\w./-]+\.\w+)/) ||
      txt.match(/^<!--\s*([\w./-]+\.\w+)\s*-->/);
    return m ? m[1] : "";
  }, [children]);

  function copyPlain() {
    const code = codeRef.current?.querySelector("code");
    const text = code?.textContent ?? "";
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div
      className="codeblock group/code my-4 overflow-hidden rounded-[var(--r-md)] border border-[#E8E5DD] bg-[#FAF8F3] shadow-[var(--shadow-1)]"
      data-lang={lang || "code"}
    >
      {/* Header — warm beige top bar, slightly darker than the code area,
         so the chrome reads as a distinct unit without yelling for attention */}
      <div className="flex items-center justify-between gap-2 border-b border-[#E8E5DD] bg-[#EFEBE0] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {lang && (
            <span className="rounded-[var(--r-sm)] bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#5A574E] ring-1 ring-inset ring-[#E8E5DD]">
              {lang}
            </span>
          )}
          {inferredFile && (
            <span className="truncate font-mono text-[11px] text-[#7A766B]">
              {inferredFile}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={copyPlain}
          aria-label={copied ? "Tersalin" : "Salin kode"}
          className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
            copied
              ? "bg-[var(--success-50)] text-[var(--success-700)]"
              : "text-[#7A766B] hover:bg-white hover:text-[#3F3E3B]"
          }`}
        >
          {copied ? (
            <>
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Tersalin</span>
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>Salin</span>
            </>
          )}
        </button>
      </div>
      <pre
        ref={codeRef}
        className="dark-scroll overflow-x-auto px-4 py-3 font-mono text-[13px] leading-[1.7] text-[#2F2E2B]"
        {...rest}
      >
        {children}
      </pre>
    </div>
  );
}
