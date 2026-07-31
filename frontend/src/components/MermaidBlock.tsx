"use client";

import { useEffect, useId, useState } from "react";

type Props = {
  code: string;
  className?: string;
};

/**
 * Client-only mermaid renderer. Dynamic import keeps mermaid out of the
 * initial chat bundle; re-runs when `code` changes.
 */
export function MermaidBlock({ code, className = "" }: Props) {
  const reactId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const source = (code || "").trim();
    if (!source) {
      setSvg(null);
      setError(null);
      return;
    }
    setError(null);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        });
        const id = `mmd-${reactId}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: out } = await mermaid.render(id, source);
        if (!cancelled) setSvg(out);
      } catch (e) {
        if (!cancelled) {
          setSvg(null);
          setError((e as Error)?.message || "mermaid render failed");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code, reactId]);

  if (error) {
    return (
      <div className={`my-4 overflow-hidden rounded-[var(--r-md)] border border-[var(--danger)]/30 bg-[var(--danger-50)]/40 ${className}`}>
        <div className="border-b border-[var(--danger)]/20 px-3 py-1.5 text-[11px] font-medium text-[var(--danger)]">
          Mermaid error
        </div>
        <pre className="m-0 overflow-x-auto p-3 font-mono text-[12px] text-[var(--ink-2)] whitespace-pre-wrap">{code}</pre>
        <div className="border-t border-[var(--danger)]/20 px-3 py-1.5 text-[11px] text-[var(--danger)]">{error}</div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={`my-4 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-3 py-6 text-center text-[12px] text-[var(--ink-3)] ${className}`}>
        Merender diagram…
      </div>
    );
  }

  return (
    <div
      className={`my-4 overflow-x-auto rounded-[var(--r-md)] border border-[var(--line)] bg-white p-4 shadow-[var(--shadow-1)] ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
