"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import { authFetch } from "@/lib/auth";
import { CenteredDialog } from "@/components/ui/Modal";
import { htmlShell } from "@/components/ArtifactViewer";

const MarkdownViewLazy = dynamic(() => import("@/components/MarkdownView"), { ssr: false });

type Artifact = {
  id: number;
  session_id: number;
  type: "html" | "jsx" | "react" | "svg" | "markdown" | "code" | "csv" | "file";
  language: string | null;
  title: string | null;
  content: string;
  version: number;
  file_path?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
};

type Props = {
  artifactId: number;
  title?: string | null;
  onClose: () => void;
};

type Mode = "preview" | "source" | "split";

const RENDERABLE: Record<Artifact["type"], boolean> = {
  html: true,
  react: true,
  svg: true,
  markdown: true,
  code: false,
  jsx: true,
  csv: true,
  file: false,
};

/**
 * Lightweight artifact viewer used by the inline ArtifactCard. Unlike
 * the full-featured ArtifactViewer in src/components/ArtifactViewer
 * (used by the side panel), this one fetches the artifact by id on
 * demand — the inline card only carries a preview string. We lazy
 * the network call until the operator actually clicks the card so
 * scroll-heavy transcripts don't pay for every card.
 *
 * Tabs:
 *   - Preview : the visual rendering (iframe for html, dangerouslySetInnerHTML for svg, etc.)
 *   - Source  : the raw text so the user can read, copy, or save it
 *   - Split   : both side-by-side (default for html/svg/react when there
 *               is room to make sense of them; markdown/code default to source)
 */
export function ArtifactViewerDialog({ artifactId, title, onClose }: Props) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("preview");
  const [copied, setCopied] = useState(false);

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

  const renderable = useMemo(
    () => (artifact ? !!RENDERABLE[artifact.type] : false),
    [artifact]
  );
  const defaultMode: Mode = useMemo(() => {
    if (!artifact) return "preview";
    return renderable ? "split" : "source";
  }, [artifact, renderable]);

  // When the artifact lands, snap to the right initial mode. Re-run
  // when artifact identity changes (different card opened).
  useEffect(() => {
    if (artifact) setMode(defaultMode);
  }, [artifact?.id, defaultMode]);

  async function copySource() {
    if (!artifact) return;
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore — clipboard unavailable in sandboxed iframes etc. */
    }
  }

  async function download() {
    if (!artifact) return;
    // Binary file artifacts: hit server download endpoint.
    if (artifact.type === "file") {
      try {
        const r = await authFetch("/api/artifacts/" + artifact.id + "/download");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (artifact.title || "file").replace(/[^A-Za-z0-9._-]+/g, "_");
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        // eslint-disable-next-line no-alert
        alert(`Gagal unduh: ${(e as Error)?.message || e}`);
      }
      return;
    }
    const blob = new Blob([artifact.content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeTitle = (artifact.title || "artifact").replace(/[^A-Za-z0-9._-]+/g, "_");
    a.download = safeTitle;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  return (
    <CenteredDialog
      open
      onClose={onClose}
      title={title || artifact?.title || "Artifact"}
      widthClass="max-w-5xl"
    >
      {!loading && artifact && (
        <div className="mb-3 flex items-center gap-1 text-[11px]">
          {renderable && (
            <TabBtn active={mode === "preview"} onClick={() => setMode("preview")}>Preview</TabBtn>
          )}
          <TabBtn active={mode === "source"} onClick={() => setMode("source")}>Source</TabBtn>
          {renderable && (
            <TabBtn active={mode === "split"} onClick={() => setMode("split")}>Split</TabBtn>
          )}
          <span className="ml-auto flex items-center gap-1">
            {artifact.type !== "file" && (
              <TabBtn onClick={copySource} active={false}>
                {copied ? "Copied" : "Copy"}
              </TabBtn>
            )}
            <TabBtn onClick={download} active={false}>
              {artifact.type === "file" ? "Unduh file" : "Download"}
            </TabBtn>
            {artifact.type !== "file" && (
              <>
                <ExportBtn
                  artifactId={artifact.id}
                  format="pdf"
                  filename={artifact.title || "artifact"}
                  content={artifact.content}
                  kind={artifact.type}
                />
                <ExportBtn
                  artifactId={artifact.id}
                  format="xlsx"
                  filename={artifact.title || "artifact"}
                  content={artifact.content}
                  kind={artifact.type}
                />
              </>
            )}
            {artifact.language && (
              <span className="rounded bg-[var(--paper-3)] px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-[var(--ink-3)]">
                {artifact.language}
              </span>
            )}
            {artifact.type === "file" && artifact.file_size != null && (
              <span className="rounded bg-[var(--paper-3)] px-2 py-1 font-mono text-[10px] text-[var(--ink-3)]">
                {formatBytes(artifact.file_size)}
              </span>
            )}
          </span>
        </div>
      )}

      {loading && (
        <div className="py-10 text-center text-sm text-[var(--ink-3)]">Memuat…</div>
      )}
      {error && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {artifact && artifact.type === "file" && (
        <FilePreviewInDialog artifact={artifact} onDownload={download} />
      )}
      {artifact && artifact.type !== "file" && (
        <div className="-mx-5 -mb-5 max-h-[70vh] overflow-hidden rounded-b-[var(--r-md)] bg-[var(--paper-2)]">
          <div className={mode === "split" ? "grid grid-cols-2 gap-px bg-[var(--line)]" : ""}>
            {(mode === "preview" || mode === "split") && renderable && (
              <div className="bg-[var(--paper-2)] p-4">
                {artifact.type === "html" ? (
                  <iframe
                    sandbox="allow-scripts"
                    srcDoc={artifact.content}
                    title={artifact.title || "HTML preview"}
                    className="h-[60vh] w-full rounded border border-[var(--line)] bg-white"
                  />
                ) : artifact.type === "react" || artifact.type === "jsx" ? (
                  <iframe
                    sandbox="allow-scripts"
                    srcDoc={htmlShell(artifact.content, artifact.language === "tsx")}
                    title={artifact.title || "React preview"}
                    className="h-[60vh] w-full rounded border border-[var(--line)] bg-white"
                  />
                ) : artifact.type === "svg" ? (
                  <iframe
                    sandbox=""
                    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100%;background:transparent}svg{max-width:100%;max-height:60vh;height:auto}</style></head><body>${artifact.content}</body></html>`}
                    title={artifact.title || "SVG preview"}
                    className="h-[60vh] w-full rounded border border-[var(--line)] bg-white"
                  />
                ) : artifact.type === "markdown" ? (
                  <div className="max-h-[60vh] overflow-auto rounded border border-[var(--line)] bg-[var(--paper)] p-4">
                    <MarkdownViewLazy content={artifact.content} />
                  </div>
                ) : artifact.type === "csv" ? (
                  <CsvTable content={artifact.content} />
                ) : null}
              </div>
            )}
            {(mode === "source" || mode === "split") && (
              <div className="bg-[var(--paper-2)]">
                <pre className="m-0 max-h-[65vh] overflow-auto whitespace-pre p-4 text-[12px] leading-[1.65] text-[var(--ink)]" style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
                  <code>{artifact.content}</code>
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </CenteredDialog>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreviewInDialog({
  artifact,
  onDownload,
}: {
  artifact: Artifact;
  onDownload: () => void;
}) {
  const lang = (artifact.language || "").toLowerCase();
  const mime = (artifact.mime_type || "").toLowerCase();
  const isPdf =
    lang === "pdf" ||
    mime === "application/pdf" ||
    (artifact.title || "").toLowerCase().endsWith(".pdf");
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isPdf || !artifact.id) return;
    let revoked: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/artifacts/${artifact.id}/download?inline=1`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const u = URL.createObjectURL(blob);
        revoked = u;
        if (!cancelled) setUrl(u);
      } catch (e) {
        if (!cancelled) setErr((e as Error)?.message || "Gagal memuat preview");
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [artifact.id, isPdf]);

  if (isPdf) {
    return (
      <div className="-mx-5 -mb-5 flex flex-col rounded-b-[var(--r-md)] bg-[var(--paper-2)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2">
          <div className="min-w-0 truncate text-[12px] text-[var(--ink-3)]">
            {(artifact.language || "pdf").toUpperCase()}
            {artifact.file_size != null ? ` · ${formatBytes(artifact.file_size)}` : ""}
          </div>
          <button
            type="button"
            onClick={onDownload}
            className="rounded-[var(--r-sm)] bg-[var(--magenta-600)] px-3 py-1 text-[12px] font-medium text-white hover:bg-[var(--magenta-700)]"
          >
            Unduh
          </button>
        </div>
        {err ? (
          <div className="p-6 text-center text-sm text-[var(--danger)]">{err}</div>
        ) : !url ? (
          <div className="p-10 text-center text-sm text-[var(--ink-3)]">Memuat preview PDF…</div>
        ) : (
          <iframe
            title={artifact.title || "PDF preview"}
            src={url}
            className="h-[60vh] w-full border-0 bg-white"
          />
        )}
      </div>
    );
  }

  return (
    <div className="-mx-5 -mb-5 rounded-b-[var(--r-md)] bg-[var(--paper-2)] p-8 text-center">
      <div className="text-sm font-semibold text-[var(--ink)]">{artifact.title || "File"}</div>
      <div className="mt-1 text-[12px] text-[var(--ink-3)]">
        {(artifact.language || "bin").toUpperCase()}
        {artifact.file_size != null ? ` · ${formatBytes(artifact.file_size)}` : ""}
      </div>
      <p className="mx-auto mt-3 max-w-md text-[13px] text-[var(--ink-2)]">
        {artifact.content || "File biner siap diunduh."}
      </p>
      <button
        type="button"
        onClick={onDownload}
        className="mt-5 rounded-[var(--r-md)] bg-[var(--magenta-600)] px-4 py-2 text-[13px] font-medium text-white hover:bg-[var(--magenta-700)]"
      >
        Unduh file
      </button>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-[var(--r-sm)] border px-2.5 py-1 text-[11px] font-medium transition " +
        (active
          ? "border-[var(--magenta-400)] bg-[var(--magenta-50)] text-[var(--magenta-700)]"
          : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-2)] hover:border-[var(--magenta-200)] hover:text-[var(--magenta-700)]")
      }
    >
      {children}
    </button>
  );
}

// Client-side export to .xlsx (via SheetJS) and .pdf (via jsPDF).
// In-browser keeps the backend slim — we don't pull in Node-native
// converters (~20MB+ of deps) that would also need a working
// network for `npm rebuild better-sqlite3` on every dependency
// change. Browsers already have a printer/PDF reader; the artifacts
// we render are text-shaped so client-side conversion stays
// predictable.
function ExportBtn({
  artifactId,
  format,
  filename,
  content,
  kind,
}: {
  artifactId: number;
  format: "xlsx" | "pdf";
  filename: string;
  content: string;
  kind: "html" | "jsx" | "react" | "svg" | "markdown" | "code" | "csv" | "file";
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const safeName = (filename || `artifact-${artifactId}`)
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 60) || `artifact-${artifactId}`;
      let blob;
      // Client export only for text-shaped artifacts (file binaries use /download).
      const exportKind = kind === "file" ? "code" : kind;
      if (format === "xlsx") {
        blob = await buildXlsx(content, exportKind, safeName);
      } else {
        blob = buildPdf(content, exportKind, safeName);
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Gagal export ${format.toUpperCase()}: ${(e as Error)?.message || e}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title={`Export sebagai ${format.toUpperCase()}`}
      className="rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1 text-[11px] font-medium text-[var(--ink-2)] transition hover:border-[var(--magenta-200)] hover:text-[var(--magenta-700)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {format === "xlsx" ? "XLSX" : "PDF"}
    </button>
  );
}

// ---- Client-side converters ----

// Token-aware CSV parser reused for the XLSX builder. Same shape as
// parseCsvLocal / parseCsv further down — duplicated here because the
// module-scope helper lives in this file already and a second import
// path would only add bundle weight.
function csvTo2DLocal(text: string, maxRows = 100_000): string[][] {
  if (!text) return [];
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      field += c; continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      out.push(row); row = [];
      if (c === "\r" && src[i + 1] === "\n") i++;
      if (out.length >= maxRows) return out;
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

async function buildXlsx(
  content: string,
  kind: "html" | "jsx" | "react" | "svg" | "markdown" | "code" | "csv",
  sheetName: string
): Promise<Blob> {
  const wb = XLSX.utils.book_new();
  let aoa: string[][];
  if (kind === "csv") {
    aoa = csvTo2DLocal(content);
  } else if (kind === "markdown") {
    // Markdown-as-prose: one row per line so the prose lands in
    // column A while column B stays free for user notes.
    aoa = [["Line", "Content"]];
    const lines = (content || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) aoa.push([String(i + 1), lines[i]]);
  } else {
    aoa = [["Content"]];
    aoa.push([content || ""]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa.length > 0 ? aoa : [[]]);
  // Sanitize sheet name — Excel forbids [\\/?*] and 31-char max.
  const safeSheet = (sheetName || "Sheet")
    .replace(/[\\/?*[\]:]/g, "_")
    .slice(0, 31) || "Sheet";
  XLSX.utils.book_append_sheet(wb, ws, safeSheet);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function buildPdf(
  content: string,
  kind: "html" | "jsx" | "react" | "svg" | "markdown" | "code" | "csv",
  title: string
): Blob {
  // A4 portrait with 56pt margins so generated PDFs echo the chat
  // dialog's relaxed reading width.
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const usableW = pageW - margin * 2;

  // Header band on page 1.
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(26, 20, 16);
  doc.text(title || "Artifact", margin, margin);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(140, 130, 120);
  doc.text(new Date().toISOString().slice(0, 10), margin, margin + 14);

  doc.setFontSize(11);
  doc.setTextColor(26, 20, 16);

  let cursorY = margin + 36;
  const newPage = () => {
    doc.addPage();
    cursorY = margin;
  };
  const ensureRoom = (h: number) => {
    if (cursorY + h > pageH - margin) newPage();
  };

  if (kind === "code" || kind === "csv") {
    doc.setFont("courier", "normal");
    doc.setFontSize(9);
    const lines = (content || "").split(/\r?\n/);
    for (const ln of lines) {
      // Wrap each line manually to avoid surprises with jsPDF's
      // auto-wrap (which would break long single-line JSON blobs
      // across pages in surprising places).
      const chunks = doc.splitTextToSize(ln || " ", usableW);
      for (const chunk of chunks) {
        ensureRoom(11);
        doc.text(chunk, margin, cursorY);
        cursorY += 11;
      }
    }
  } else if (kind === "markdown") {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    const stripped = (content || "")
      .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3))
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/^>\s?/gm, "");
    const paragraphs = stripped.split(/\n{2,}/);
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      const wrapped = doc.splitTextToSize(trimmed, usableW);
      const lineH = 14;
      ensureRoom(lineH * (wrapped.length + 1));
      doc.text(wrapped, margin, cursorY);
      cursorY += lineH * wrapped.length + 6;
    }
  } else {
    // html/jsx/react/svg fall back to PDF-as-plain-prose; the user
    // can always use the in-dialog preview to view the rendered
    // artifact. We still produce a usable file so "Export PDF" isn't
    // a 400 for any artifact type.
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    const wrapped = doc.splitTextToSize(content || "", usableW);
    ensureRoom(14 * (wrapped.length + 1));
    doc.text(wrapped, margin, cursorY);
  }
  return doc.output("blob");
}

/**
 * Tiny CSV parser that handles quoted fields (RFC 4180, single-line
 * entries with embedded commas + double-quote escapes via ""). The
 * preview scans at most MAX_ROWS so wide tables don't freeze the
 * dialog; the user can switch to the Source tab to see the raw text.
 */
function CsvTable({ content }: { content: string }) {
  const MAX_ROWS = 200;
  const rows = useMemo(() => parseCsv(content, MAX_ROWS), [content]);
  if (rows.length === 0) {
    return (
      <div className="rounded border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink-3)]">
        CSV kosong atau tidak dapat di-parse.
      </div>
    );
  }
  const header = rows[0];
  const body = rows.slice(1);
  return (
    <div className="max-h-[60vh] overflow-auto rounded border border-[var(--line)] bg-[var(--paper)]">
      <table className="w-full border-collapse text-[12px] leading-[1.55]">
        <thead className="sticky top-0 z-10 bg-[var(--paper-3)] text-left">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border-b border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? "bg-transparent" : "bg-[var(--paper-2)]/40"}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="border-b border-[var(--line)] px-3 py-1.5 align-top text-[var(--ink)]"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length === MAX_ROWS - 1 && (
        <div className="border-t border-[var(--line)] bg-[var(--paper-3)] px-3 py-1.5 text-[11px] text-[var(--ink-3)]">
          Preview terbatas ke {MAX_ROWS} baris pertama. Buka tab Source untuk
          salin CSV lengkap.
        </div>
      )}
    </div>
  );
}

// Minimal RFC 4180-ish CSV parser. Returns array of rows; each row is
// an array of cell strings. Embedded newlines inside quoted fields
// are supported, embedded commas are kept inside the quoted field,
// and "" inside a quoted field is unescaped to a single ".
function parseCsv(text: string, maxRows = 1000): string[][] {
  if (!text) return [];
  const out = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  // Cap iteration to avoid pathological inputs hogging the UI thread.
  const HARD_CAP = 4 * 1024 * 1024;
  if (text.length > HARD_CAP) text = text.slice(0, HARD_CAP);
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') {
      // \r\n or lone \r — finish row either way.
      row.push(field); field = "";
      out.push(row); row = [];
      i++;
      if (text[i] === '\n') i++;
      if (out.length >= maxRows) return out;
      continue;
    }
    if (c === '\n') {
      row.push(field); field = "";
      out.push(row); row = [];
      i++;
      if (out.length >= maxRows) return out;
      continue;
    }
    field += c; i++;
  }
  // Trailing field/row if file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

