"use client";

import { useMemo, useRef, useState, isValidElement, type ReactNode } from "react";
import { MermaidBlock } from "@/components/MermaidBlock";

/**
 * Wraps a codeblock with a soft header (language badge + filename + copy).
 * language-mermaid → live diagram (MermaidBlock).
 * All hooks run unconditionally before any early return.
 */
export function CodeBlock({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement | null>(null);

  const lang = useMemo(() => {
    const fromPre = (className || "").match(/language-(\w+)/);
    if (fromPre) return fromPre[1];
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const props = child.props as { className?: string };
      const fromCode = (props.className || "").match(/language-(\w+)/);
      if (fromCode) return fromCode[1];
    }
    return "";
  }, [className, children]);

  const plain = useMemo(() => extractPlainText(children).trim(), [children]);

  const mermaidSource = lang === "mermaid" && plain ? plain : null;

  const inferredFile = useMemo(() => {
    const txt = plain || "";
    const m =
      txt.match(/^\/\/\s*([\w./-]+\.\w+)/) ||
      txt.match(/^#\s*([\w./-]+\.\w+)/) ||
      txt.match(/^<!--\s*([\w./-]+\.\w+)\s*-->/);
    return m ? m[1] : "";
  }, [plain]);

  if (mermaidSource) {
    return <MermaidBlock code={mermaidSource} />;
  }

  function copyPlain() {
    const code = codeRef.current?.querySelector("code");
    const text = code?.textContent ?? plain;
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

function extractPlainText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractPlainText).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractPlainText(props.children);
  }
  return "";
}
