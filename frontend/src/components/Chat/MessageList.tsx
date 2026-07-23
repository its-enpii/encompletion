"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import ToolBlock, { type ToolUse } from "@/components/ToolBlock";
import { MessageBubble, TypingPill } from "./MessageBubble";
import { JumpToBottom } from "./JumpToBottom";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactViewerDialog } from "./ArtifactViewerDialog";
import type { Att, Msg } from "./types";

type ArtifactLite = {
  id: number;
  type: string;
  language: string | null;
  title: string | null;
  // Truncated preview for the card body. Full content loads from
  // ArtifactViewer modal where it can stream in lazily.
  content_preview: string;
  line_count: number;
};

export function MessageList({
  messages,
  toolUses,
  attachmentsByMsg,
  artifactsByMsg,
  streaming,
  showJump,
  onScroll,
  onJump,
  mainScrollRef,
  sessionId,
  onRegenerate,
}: {
  messages: Msg[];
  toolUses: ToolUse[];
  attachmentsByMsg: Record<number, Att[]>;
  artifactsByMsg: Record<number, ArtifactLite[]>;
  streaming: boolean;
  showJump: boolean;
  onScroll: (gap: number) => void;
  onJump: () => void;
  mainScrollRef: React.RefObject<HTMLDivElement | null>;
  sessionId: number | null;
  onRegenerate?: (assistantMsgId: number) => void;
}) {
  const [openArtifact, setOpenArtifact] = useState<{ id: number; title?: string | null } | null>(null);
  // Inline image preview modal — opens when the user clicks an image
  // attachment in a message bubble. Showing a full-resolution preview
  // in-app (instead of opening a new tab) keeps the chat scroll position
  // and context. Esc + backdrop click dismiss.
  const [openImage, setOpenImage] = useState<{ url: string; name: string } | null>(null);
  // Non-image attachment preview — opens when the user clicks a text
  // or document attachment in a message bubble. Fetches the raw file
  // content and renders it inline (text, markdown, code highlight).
  const [openFile, setOpenFile] = useState<Att | null>(null);
  useEffect(() => {
    if (!openImage && !openFile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpenImage(null);
        setOpenFile(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openImage, openFile]);
  return (
    <div
      ref={mainScrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        onScroll(gap);
      }}
      className="relative flex-1 overflow-y-auto bg-[var(--paper)]"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-7 px-4 py-10">
        {messages.length === 0 && !streaming && <EmptyHero />}
        {messages.map((m, idx) => {
          const prev = messages[idx - 1];
          const showAvatar = !prev || prev.role !== m.role || m.role === "user";
          return (
            <div key={m.id} className="flex flex-col gap-2.5">
              {attachmentsByMsg[m.id]?.length ? (
                <AttachmentStrip
                  atts={attachmentsByMsg[m.id]}
                  align={m.role === "user" ? "right" : "left"}
                  showIndent={!showAvatar && m.role === "assistant"}
                  onOpenImage={setOpenImage}
                  onOpenText={setOpenFile}
                />
              ) : null}
              <div className={showAvatar ? "" : "pl-12"}>
                <MessageBubble
                  msg={m}
                  sessionId={sessionId}
                  onRegenerate={m.role === "assistant" && onRegenerate ? () => onRegenerate(m.id) : undefined}
                  attachments={attachmentsByMsg[m.id]}
                />
              </div>
              {m.role === "assistant" &&
                toolUses
                  .filter((t) => t.message_id === m.id)
                  .map((t) => (
                    <div key={t.tool_use_id || t.id} className={showAvatar ? "pl-12" : "pl-12"}>
                      <ToolBlock tool={t} />
                    </div>
                  ))}
              {m.role === "assistant" && artifactsByMsg[m.id]?.length ? (
                <div className="flex flex-col gap-2 pl-12">
                  {artifactsByMsg[m.id].map((a) => (
                    <ArtifactCard
                      key={a.id}
                      artifact={a}
                      onOpen={() => setOpenArtifact({ id: a.id, title: a.title })}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {streaming && messages[messages.length - 1]?.role !== "assistant" && (
          <TypingPill />
        )}
        <div className="h-6" />
      </div>
      {showJump && <JumpToBottom onClick={onJump} />}
      {openArtifact && (
        <ArtifactViewerDialog
          artifactId={openArtifact.id}
          title={openArtifact.title}
          onClose={() => setOpenArtifact(null)}
        />
      )}
      {openImage && (
        // Backdrop + image. Same look as the existing ArtifactViewer
        // overlay (blurred paper-tone backdrop) so it reads as part of
        // the same family. Drag-to-close is a stretch goal; clicks on
        // the backdrop or the close button dismiss.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${openImage.name}`}
          className="anim-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-[#1A1410]/70 backdrop-blur-sm"
          onClick={() => setOpenImage(null)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[90vw] flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={openImage.url}
              alt={openImage.name}
              className="max-h-[85vh] max-w-[90vw] rounded-[var(--r-md)] object-contain shadow-[var(--shadow-4)]"
              draggable={false}
            />
            <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--paper-3)] px-3 py-1.5 shadow-[var(--shadow-2)]">
              <span className="truncate text-xs font-medium text-[var(--ink-2)]">{openImage.name}</span>
              <div className="flex items-center gap-1">
                <a
                  href={openImage.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                  title="Open in new tab"
                >
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => setOpenImage(null)}
                  className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                  aria-label="Close preview"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {openFile && (
        <FilePreviewModal att={openFile} onClose={() => setOpenFile(null)} />
      )}
    </div>
  );
}

function AttachmentStrip({
  atts,
  align,
  showIndent,
  onOpenImage,
  onOpenText,
}: {
  atts: Att[];
  align: "left" | "right";
  showIndent?: boolean;
  onOpenImage: (img: { url: string; name: string }) => void;
  onOpenText: (att: Att) => void;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${align === "right" ? "justify-end" : "pl-12"}`}>
      {atts.map((a) => {
        const isImage = (a.mime_type || "").startsWith("image/");
        if (isImage) {
          // Image attachments render as a thumbnail tile. Click opens
          // the in-app preview modal (in-page, preserves scroll/state)
          // rather than a new tab — the user is usually confirming what
          // the model saw, and bouncing out of the chat is jarring.
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onOpenImage({ url: a.url, name: a.file_name })}
              title={a.file_name}
              className="group/att relative block h-20 w-20 overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-2)]"
            >
              <img
                src={a.url}
                alt={a.file_name}
                className="h-full w-full object-cover"
                draggable={false}
                loading="lazy"
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-0.5 pt-3 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover/att:opacity-100">
                {a.file_name}
              </span>
            </button>
          );
        }
        // Non-image attachment — show as a mini preview card that
        // gives the user something visual to confirm what they sent,
        // instead of a paperclip chip with the filename only. Opens
        // the file preview modal on click (which knows how to render
        // the extracted text / rendered markdown / PDF text).
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpenText(a)}
            title={a.file_name}
            className="group/att flex w-44 flex-col items-stretch overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] text-left shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-2)]"
          >
            <TextPreview att={a} />
            <span className="flex items-center gap-1.5 border-t border-[var(--line)] bg-[var(--paper)] px-2 py-1.5">
              <KindGlyph mime={a.mime_type} name={a.file_name} />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--ink-2)]">
                {a.file_name}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function KindGlyph({ mime, name }: { mime: string; name: string }) {
  // Same color/label mapping as the composer AttachmentTile so the
  // chat bubble stays consistent with the upload chip.
  const dot = name.lastIndexOf(".");
  const ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
  let label = ext.slice(0, 4).toUpperCase() || "FILE";
  let bg = "var(--paper-3)";
  let fg = "var(--ink-3)";
  if (mime.startsWith("text/markdown") || ext === "md" || ext === "mdx") {
    label = "MD"; bg = "var(--magenta-50)"; fg = "var(--magenta-700)";
  } else if (mime.startsWith("text/")) {
    label = "TXT"; bg = "var(--ink-2)"; fg = "var(--paper)";
  } else if (mime === "application/pdf" || ext === "pdf") {
    label = "PDF"; bg = "#FEE2E2"; fg = "#B91C1C";
  } else if (ext === "docx" || mime.includes("wordprocessingml")) {
    label = "DOCX"; bg = "#DBEAFE"; fg = "#1D4ED8";
  } else if (ext === "xlsx" || ext === "xls" || ext === "csv" ||
             mime.includes("spreadsheetml") || mime === "text/csv") {
    label = ext === "csv" ? "CSV" : "XLSX";
    bg = "#DCFCE7"; fg = "#15803D";
  } else if (mime.startsWith("application/json") || ext === "json") {
    label = "JSON"; bg = "var(--magenta-50)"; fg = "var(--magenta-700)";
  }
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] text-[8px] font-bold uppercase"
      style={{ background: bg, color: fg }}
      aria-hidden
    >
      {label}
    </span>
  );
}

function TextPreview({ att }: { att: Att }) {
  // Best-effort 1-line preview of the file's text. The Att row from
  // the DB doesn't carry the extracted content; we hit
  // /api/attachments/file/... which returns the raw binary, then for
  // text-ish kinds decode inline. PDF/DOCX/XLSX are skipped here —
  // their preview comes from the modal that opens on click.
  const mime = (att.mime_type || "").toLowerCase();
  const dot = att.file_name.lastIndexOf(".");
  const ext = (dot >= 0 ? att.file_name.slice(dot + 1) : "").toLowerCase();
  const isText = mime.startsWith("text/") || ["md","markdown","json","xml","yaml","yml","csv","tsv","log","txt","env","ini","toml","js","jsx","ts","tsx","vue","svelte","html","css","scss","py","rb","go","rs","java","kt","swift","php","sql","sh","bash","zsh"].includes(ext);
  const [snippet, setSnippet] = useState<string | null>(null);
  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    fetch(att.url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (cancelled) return;
        const trimmed = t.replace(/\s+/g, " ").trim();
        setSnippet(trimmed.slice(0, 200));
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [att.url, isText]);
  return (
    <div className="flex h-12 items-center gap-2 bg-[var(--paper-2)] px-2.5">
      {snippet ? (
        <span className="line-clamp-2 text-[10px] leading-tight text-[var(--ink-2)] font-mono">
          {snippet || <span className="text-[var(--ink-3)]">(empty)</span>}
        </span>
      ) : (
        <span className="text-[10px] text-[var(--ink-3)]">
          {isText ? "…" : `${att.size ? Math.max(1, Math.round(att.size / 1024)) + " KB" : ""}`}
        </span>
      )}
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="mx-auto mt-4 flex max-w-2xl flex-col items-center gap-6 text-center anim-fade-in">
      <div className="relative">
        <div className="absolute inset-0 animate-pulse rounded-full bg-[var(--saffron)] opacity-20 blur-2xl" />
        <div className="relative grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-[var(--saffron-100)] via-[var(--saffron-300)] to-[var(--saffron-500)] text-[var(--ink)] shadow-[inset_0_2px_0_rgba(255,255,255,0.5),0_8px_24px_rgba(232,162,43,0.25)]">
          <svg viewBox="0 0 24 24" className="h-8 w-8 fill-current">
            <path d="M12 2 L22 12 L12 22 L2 12 Z" />
          </svg>
        </div>
      </div>

      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">
          Mulai percakapan baru
        </h2>
        <p className="mt-1.5 text-sm text-[var(--ink-3)]">
          Tanyakan apa saja. Konteks diingat selama sesi berlangsung.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        <SuggestionCard
          icon="code"
          title="Jelaskan kode ini"
          subtitle="Tempel snippet, dapat penjelasan baris per baris"
        />
        <SuggestionCard
          icon="bug"
          title="Debug error ini"
          subtitle="Paste stack trace, dapat diagnosis & fix"
        />
        <SuggestionCard
          icon="rocket"
          title="Buatkan boilerplate"
          subtitle="Scaffold project, komponen, atau test"
        />
        <SuggestionCard
          icon="git"
          title="Review pull request"
          subtitle="Dapatkan feedback & saran refactor"
        />
      </div>

      {/* No footer attribution — we deliberately do not surface engine
          identity or model name on the public welcome surface. Operators
          who want a visible badge can add one here. */}
    </div>
  );
}

function SuggestionCard({
  icon,
  title,
  subtitle,
}: {
  icon: "code" | "bug" | "rocket" | "git";
  title: string;
  subtitle: string;
}) {
  return (
    <button className="group/sugg flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] p-3.5 text-left shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-2)]">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--saffron-50)] text-[var(--saffron-500)] transition-colors group-hover/sugg:bg-[var(--saffron-100)]">
        <SuggestionIcon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-[var(--ink)]">{title}</div>
        <div className="mt-0.5 text-xs text-[var(--ink-3)]">{subtitle}</div>
      </div>
      <svg viewBox="0 0 24 24" className="mt-2 h-3.5 w-3.5 shrink-0 text-[var(--ink-3)] transition-transform group-hover/sugg:translate-x-1" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
}

function SuggestionIcon({ name, ...props }: { name: "code" | "bug" | "rocket" | "git" } & React.SVGProps<SVGSVGElement>) {
  if (name === "code") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
  if (name === "bug") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="8" y="6" width="8" height="14" rx="4" /><line x1="3" y1="13" x2="6" y2="13" /><line x1="18" y1="13" x2="21" y2="13" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="3" y1="3" x2="6" y2="6" /><line x1="18" y1="6" x2="21" y2="3" /></svg>;
  if (name === "rocket") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>;
}

const CODE_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
  html: "html", htm: "html", css: "css", json: "json", yaml: "yaml",
  yml: "yaml", toml: "ini", ini: "ini", vue: "html", svelte: "html",
};

function FilePreviewModal({ att, onClose }: { att: Att; onClose: () => void }) {
  const mime = (att.mime_type || "").toLowerCase();
  const dot = att.file_name.lastIndexOf(".");
  const ext = (dot >= 0 ? att.file_name.slice(dot + 1) : "").toLowerCase();
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf" || ext === "pdf";
  const isDocx = ext === "docx" || mime.includes("wordprocessingml");
  const isXlsx = ["xlsx", "xls", "csv"].includes(ext) || mime.includes("spreadsheetml") || mime === "text/csv";
  const isText = mime.startsWith("text/") || !!CODE_LANGS[ext];
  const isMd = mime === "text/markdown" || ext === "md" || ext === "mdx";

  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isText && !isDocx && !isXlsx) return;
    let cancelled = false;
    fetch(att.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setError(e?.message || "Gagal load file"); });
    return () => { cancelled = true; };
  }, [att.url, isText, isDocx, isXlsx]);

  // Lazy-load MarkdownView to avoid SSR (it uses heavy markdown deps).
  const MarkdownView = useMemo(
    () => dynamic(() => import("@/components/MarkdownView").then(m => m.default), { ssr: false }),
    []
  );

  const lang = CODE_LANGS[ext];
  const previewText = isDocx || isXlsx
    ? (text || "").replace(/\s+/g, " ").trim()
    : (text || "");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${att.file_name}`}
      className="anim-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-[#1A1410]/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[88vh] max-w-[90vw] flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex max-h-[80vh] w-[min(800px,90vw)] flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] shadow-[var(--shadow-4)]">
          {isImage ? (
            <img
              src={att.url}
              alt={att.file_name}
              className="max-h-[75vh] w-full object-contain"
              draggable={false}
            />
          ) : isMd ? (
            <div className="max-h-[75vh] overflow-y-auto p-5">
              {text == null ? (
                <div className="text-sm text-[var(--ink-3)]">Memuat…</div>
              ) : (
                <MarkdownView content={text || "_(kosong)_"} />
              )}
            </div>
          ) : lang ? (
            <pre className="dark-scroll max-h-[75vh] overflow-auto p-4 font-mono text-[12px] leading-relaxed">
              <code className={`language-${lang}`}>{text ?? "Memuat…"}</code>
            </pre>
          ) : isText ? (
            <pre className="dark-scroll max-h-[75vh] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-[var(--ink-2)]">
              {text ?? "Memuat…"}
            </pre>
          ) : isPdf ? (
            <iframe
              src={att.url}
              title={att.file_name}
              className="h-[75vh] w-full bg-white"
            />
          ) : isDocx || isXlsx ? (
            <div className="max-h-[75vh] overflow-y-auto p-5">
              {error ? (
                <div className="text-sm text-[var(--danger)]">Gagal baca file: {error}</div>
              ) : text == null ? (
                <div className="text-sm text-[var(--ink-3)]">Memuat…</div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[var(--ink-2)]">
                  {previewText || "_(tidak ada teks yang bisa diekstrak)_"}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-[var(--ink-3)]">
              <span className="text-sm">Preview tidak tersedia untuk tipe file ini.</span>
              <a
                href={att.url}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-[var(--magenta-600)] underline-offset-2 hover:underline"
              >
                Buka di tab baru
              </a>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--paper-3)] px-3 py-1.5 shadow-[var(--shadow-2)]">
          <span className="truncate text-xs font-medium text-[var(--ink-2)]">{att.file_name}</span>
          <div className="flex items-center gap-1">
            <a
              href={att.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
              title="Open in new tab"
            >
              Open
            </a>
            <button
              type="button"
              onClick={onClose}
              className="grid h-6 w-6 place-items-center rounded-[6px] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
              aria-label="Close preview"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}