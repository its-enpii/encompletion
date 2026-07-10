"use client";

import { useEffect, useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";

type Artifact = {
  id: number;
  session_id: number;
  type: "html" | "jsx" | "react" | "svg" | "markdown" | "code";
  language: string | null;
  title: string | null;
  content: string;
  version: number;
};

type Props = {
  artifactId: number;
  title?: string | null;
  onClose: () => void;
};

/**
 * Lightweight artifact viewer used by the inline ArtifactCard. Unlike
 * the full-featured ArtifactViewer in src/components/ArtifactViewer
 * (used by the side panel), this one fetches the artifact by id on
 * demand — the inline card only carries a preview string. We lazy
 * the network call until the operator actually clicks the card so
 * scroll-heavy transcripts don't pay for every card.
 */
export function ArtifactViewerDialog({ artifactId, title, onClose }: Props) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch("/api/artifacts/" + artifactId)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        if (cancelled) return;
        setArtifact(data);
      })
      .catch((e) => { if (!cancelled) setError(e?.message || "failed to load"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifactId]);

  return (
    <CenteredDialog
      open
      onClose={onClose}
      title={title || artifact?.title || "Artifact"}
      widthClass="max-w-4xl"
    >
      {loading && (
        <div className="py-10 text-center text-sm text-[var(--ink-3)]">Memuat…</div>
      )}
      {error && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {artifact && (
        <div className="-mx-5 -mb-5 max-h-[70vh] overflow-auto rounded-b-[var(--r-md)] bg-[var(--paper-2)] p-5">
          {artifact.type === "html" ? (
            <iframe
              sandbox="allow-scripts"
              srcDoc={artifact.content}
              title={artifact.title || "HTML preview"}
              className="h-[60vh] w-full rounded border border-[var(--line)] bg-white"
            />
          ) : artifact.type === "svg" ? (
            <div
              className="flex min-h-[200px] items-center justify-center [&_svg]:h-auto [&_svg]:max-h-[60vh] [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: artifact.content }}
            />
          ) : artifact.type === "markdown" ? (
            <pre className="m-0 whitespace-pre-wrap font-mono text-[12px] leading-[1.65] text-[var(--ink)]">
{artifact.content}
            </pre>
          ) : (
            <pre className="m-0 overflow-auto rounded bg-[var(--paper-3)] p-3 text-[12px] leading-[1.65] text-[var(--ink)]" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
              <code>{artifact.content}</code>
            </pre>
          )}
        </div>
      )}
    </CenteredDialog>
  );
}
