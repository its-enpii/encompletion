"use client";

import { useState } from "react";
import ArtifactViewer, { type Artifact } from "./ArtifactViewer";
import { Button } from "@/components/ui/Button";
import { authFetch } from "@/lib/auth";

type Props = {
  artifacts: Artifact[];
  sessionId?: number | null;
  onClose?: () => void;
};

const TYPE_META: Record<Artifact["type"], { color: string; bg: string }> = {
  html: { color: "var(--saffron-700)", bg: "var(--saffron-50)" },
  jsx: { color: "#0EA5E9", bg: "rgba(14,165,233,0.10)" },
  react: { color: "#06B6D4", bg: "rgba(6,182,212,0.10)" },
  svg: { color: "#8B5CF6", bg: "rgba(139,92,246,0.10)" },
  markdown: { color: "var(--ink-2)", bg: "var(--paper-2)" },
  code: { color: "var(--ink-2)", bg: "var(--paper-2)" },
  csv: { color: "#16A34A", bg: "rgba(22,163,74,0.10)" },
};

export default function ArtifactPanel({ artifacts, sessionId, onClose }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  async function downloadZip() {
    if (sessionId == null || artifacts.length === 0 || zipBusy) return;
    setZipBusy(true);
    setZipError(null);
    try {
      // Server-side ZIP includes every artifact (not just the one
      // currently shown). For partial bundles the route also accepts
      // ?ids=1,2,3 but the session-wide export is what users want
      // when they say "give me everything".
      const r = await authFetch(`/api/sessions/${sessionId}/artifacts.zip`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const dispo = r.headers.get("Content-Disposition") || "";
      const match = /filename="?([^";]+)"?/i.exec(dispo);
      const filename = match?.[1] || `artifacts-session-${sessionId}.zip`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setZipError(e?.message || "Gagal membuat ZIP");
    } finally {
      setZipBusy(false);
    }
  }
  const shellCls =
    "fixed inset-x-0 bottom-0 z-30 flex flex-col border-t border-[var(--line)] bg-[var(--paper-2)] shadow-[0_-8px_32px_-12px_rgba(26,20,16,0.18)] md:static md:inset-auto md:h-auto md:shrink-0 md:border-l md:border-t-0 md:shadow-none";

  if (!artifacts.length) {
    return (
      <aside className={`${shellCls} h-[60vh] md:w-96`}>
        <PanelHeader title="Artifacts" subtitle="Output dari asisten" onClose={onClose} />
        <EmptyArtifacts />
      </aside>
    );
  }

  const active = artifacts[activeIdx] ?? artifacts[0];
  const meta = TYPE_META[active.type] ?? TYPE_META.code;
  const safeIdx = Math.min(activeIdx, artifacts.length - 1);

  return (
    <aside className={`${shellCls} h-[75vh] md:w-[30rem]`}>
      <PanelHeader
        title="Artifacts"
        subtitle={`${artifacts.length} item${artifacts.length === 1 ? "" : "s"}`}
        onClose={onClose}
        accent={
          <span
            className="grid h-7 w-7 place-items-center rounded-[var(--r-md)] text-[10px] font-bold uppercase"
            style={{ background: meta.bg, color: meta.color }}
          >
            {artifacts.length}
          </span>
        }
        actions={
          sessionId != null && artifacts.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={downloadZip}
              disabled={zipBusy}
              title="Download semua artifact sesi ini sebagai .zip"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span className="hidden sm:inline">{zipBusy ? "Membuat…" : "ZIP"}</span>
            </Button>
          ) : null
        }
      />
      {zipError && (
        <div className="border-b border-[var(--line)] bg-[var(--danger-50)] px-3 py-2 text-[11px] text-[var(--danger)]">
          {zipError}
        </div>
      )}

      {artifacts.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--line)] bg-[var(--paper-3)] px-2.5 py-2">
          {artifacts.map((a, i) => {
            const m = TYPE_META[a.type] ?? TYPE_META.code;
            const isActive = i === safeIdx;
            return (
              <button
                key={a.id}
                onClick={() => setActiveIdx(i)}
                className={`group/chip inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-md)] border px-2.5 py-1.5 text-[11px] font-medium transition-all ${
                  isActive
                    ? "border-transparent bg-[var(--paper)] text-[var(--ink)] shadow-[var(--shadow-2)]"
                    : "border-[var(--line)] text-[var(--ink-2)] hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
                }`}
                title={a.title || a.type}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: m.color }}
                  aria-hidden
                />
                <span className="truncate max-w-[140px]">
                  {a.title || `${a.type} #${a.id}`}
                </span>
                {a.version > 1 && (
                  <span className="font-mono text-[9px] text-[var(--ink-4)]">v{a.version}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        <ArtifactViewer artifact={artifacts[safeIdx]} />
      </div>
    </aside>
  );
}

function PanelHeader({
  title,
  subtitle,
  accent,
  actions,
  onClose,
}: {
  title: string;
  subtitle?: string;
  accent?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--paper-3)] px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {accent ?? (
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-md)] bg-[var(--magenta-50)] text-[var(--magenta-700)]"
            aria-hidden
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 22 12 2 12" />
            </svg>
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-tight text-[var(--ink)]">
            {title}
          </div>
          {subtitle && (
            <div className="truncate text-[10px] text-[var(--ink-3)]">{subtitle}</div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} title="Tutup panel">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </Button>
        )}
      </div>
    </div>
  );
}

function EmptyArtifacts() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-[var(--r-lg)] bg-gradient-to-br from-[var(--magenta-50)] to-[var(--saffron-50)] text-[var(--magenta-600)]">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 22 12 12 22 2 12" />
          <line x1="12" y1="2" x2="12" y2="22" />
          <line x1="2" y1="12" x2="22" y2="12" />
        </svg>
      </div>
      <div>
        <p className="text-[13px] font-medium text-[var(--ink)]">Belum ada artifact</p>
        <p className="mt-1 text-[11px] text-[var(--ink-3)]">
          HTML, React, SVG, Markdown, atau kode akan muncul di sini saat asisten mengirim output.
        </p>
      </div>
    </div>
  );
}
