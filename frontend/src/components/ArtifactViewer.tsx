"use client";

import { useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

export type Artifact = {
  id: number;
  session_id: number;
  type: "html" | "jsx" | "react" | "svg" | "markdown" | "code";
  language: string | null;
  title: string | null;
  content: string;
  version: number;
  dup_of?: number | null;
};

type Props = {
  artifact: Artifact;
};

const TYPE_META: Record<Artifact["type"], { icon: React.ReactNode; label: string; color: string; bg: string }> = {
  html: { icon: <HtmlIcon />, label: "HTML", color: "var(--saffron-700)", bg: "var(--saffron-50)" },
  jsx: { icon: <CodeIcon />, label: "JSX", color: "#0EA5E9", bg: "rgba(14,165,233,0.10)" },
  react: { icon: <ReactIcon />, label: "React", color: "#06B6D4", bg: "rgba(6,182,212,0.10)" },
  svg: { icon: <SvgIcon />, label: "SVG", color: "#8B5CF6", bg: "rgba(139,92,246,0.10)" },
  markdown: { icon: <MarkdownIcon />, label: "Markdown", color: "var(--ink-2)", bg: "var(--paper-2)" },
  code: { icon: <CodeIcon />, label: "Code", color: "var(--ink-2)", bg: "var(--paper-2)" },
};

export default function ArtifactViewer({ artifact }: Props) {
  const [tab, setTab] = useState<"render" | "code">("render");
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const meta = TYPE_META[artifact.type] ?? TYPE_META.code;
  const displayTitle = artifact.title || `Untitled ${meta.label}`;
  const ext = extFor(artifact);
  const lineCount = artifact.content.split("\n").length;
  const byteSize = new Blob([artifact.content]).size;

  function copy() {
    navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  function download() {
    const blob = new Blob([artifact.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(artifact.title) || `artifact-${artifact.id}`}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inner = (
    <div className="flex h-full flex-col bg-[var(--paper)]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-3)] px-3.5 py-2.5">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--r-md)]"
          style={{ background: meta.bg, color: meta.color }}
          aria-hidden
        >
          {meta.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[var(--ink)]">
              {displayTitle}
            </span>
            {artifact.version > 1 && (
              <span
                className="rounded-full bg-[var(--paper-2)] px-1.5 py-0.5 text-[10px] font-mono font-medium text-[var(--ink-3)] ring-1 ring-inset ring-[var(--line)]"
                title={`Version ${artifact.version}`}
              >
                v{artifact.version}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--ink-3)]">
            <span className="font-mono uppercase tracking-[0.04em]">{meta.label}</span>
            {artifact.language && (
              <>
                <span className="h-0.5 w-0.5 rounded-full bg-[var(--ink-4)]" />
                <span className="font-mono">{artifact.language}</span>
              </>
            )}
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--ink-4)]" />
            <span>{lineCount} baris</span>
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--ink-4)]" />
            <span>{formatBytes(byteSize)}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <div className="mr-1 flex items-center rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
            <Tab active={tab === "render"} onClick={() => setTab("render")} label="Render">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor"><polygon points="6 4 20 12 6 20" /></svg>
            </Tab>
            <Tab active={tab === "code"} onClick={() => setTab("code")} label="Kode">
              <CodeIcon className="h-3 w-3" />
            </Tab>
          </div>
          <Button variant="ghost" size="sm" onClick={copy} title="Salin kode">
            {copied ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={download} title={`Unduh .${ext}`}>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setFullscreen(true)} title="Layar penuh">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {tab === "code" ? (
          <CodeView content={artifact.content} language={artifact.language} />
        ) : (
          <RenderedArtifact artifact={artifact} />
        )}
      </div>
    </div>
  );

  return (
    <>
      {inner}
      <CenteredDialog
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={displayTitle}
        widthClass="max-w-6xl"
      >
        <div className="-mx-5 -mb-5 h-[80vh]">{inner}</div>
      </CenteredDialog>
    </>
  );
}

function Tab({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-6 items-center gap-1 rounded-[7px] px-2 text-[11px] font-medium transition-all ${
        active
          ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
          : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function CodeView({ content, language }: { content: string; language: string | null }) {
  const lines = content.split("\n");
  return (
    <div className="relative">
      <pre className="m-0 overflow-auto bg-[var(--paper-2)] p-0 text-[12px] leading-[1.65] text-[var(--ink)]">
        <code className={`block min-h-full font-mono ${language ? `language-${language}` : ""}`}>
          {lines.map((line, i) => (
            <div key={i} className="group/line flex">
              <span
                className="sticky left-0 inline-block w-12 shrink-0 select-none border-r border-[var(--line)] bg-[var(--paper-2)] px-2 py-0 text-right font-mono text-[10px] text-[var(--ink-4)] group-hover/line:text-[var(--ink-3)]"
                aria-hidden
              >
                {i + 1}
              </span>
              <span className="flex-1 whitespace-pre px-3 py-0">{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function RenderedArtifact({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "html") {
    return (
      <div className="h-full w-full bg-white">
        <iframe
          sandbox="allow-scripts"
          srcDoc={artifact.content}
          title={artifact.title || "HTML preview"}
          className="h-full w-full border-0"
        />
      </div>
    );
  }
  if (artifact.type === "svg") {
    return (
      <div className="flex h-full min-h-[200px] w-full items-center justify-center bg-[var(--paper-2)] p-6">
        <div
          className="max-h-full max-w-full overflow-auto [&_svg]:h-auto [&_svg]:max-h-[60vh] [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: artifact.content }}
        />
      </div>
    );
  }
  if (
    artifact.type === "react" ||
    (artifact.type === "code" && (artifact.language === "jsx" || artifact.language === "tsx"))
  ) {
    return (
      <div className="h-full w-full bg-white">
        <iframe
          sandbox="allow-scripts"
          srcDoc={htmlShell(artifact.content, artifact.language === "tsx")}
          title={artifact.title || "React preview"}
          className="h-full w-full border-0"
        />
      </div>
    );
  }
  if (artifact.type === "markdown") {
    return (
      <div className="bg-[var(--paper)] p-6">
        <div className="prose prose-sm max-w-none text-[var(--ink)]">
          <Markdown content={artifact.content} />
        </div>
      </div>
    );
  }
  return (
    <div className="bg-[var(--paper-2)] p-4">
      <pre className="m-0 whitespace-pre-wrap font-mono text-[12px] leading-[1.65] text-[var(--ink)]">
        {artifact.content}
      </pre>
    </div>
  );
}

function htmlShell(code: string, isTs = false) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px;font-family:ui-sans-serif,system-ui,sans-serif;background:#FAF8F3;color:#1A1410;line-height:1.55}
</style>
</head><body><div id="root"></div>
<script type="text/babel" data-presets="env,react${isTs ? ",typescript" : ""}" data-type="module">
${code}
</script></body></html>`;
}

function Markdown({ content }: { content: string }) {
  // Heading
  let html = content
    .replace(/^### (.*)$/gm, '<h3 class="text-base font-semibold mt-5 mb-2 text-[var(--ink)]">$1</h3>')
    .replace(/^## (.*)$/gm, '<h2 class="text-lg font-semibold mt-6 mb-2.5 text-[var(--ink)]">$1</h2>')
    .replace(/^# (.*)$/gm, '<h1 class="text-2xl font-bold mt-6 mb-3 text-[var(--ink)]">$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-[var(--ink)]">$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em class="italic">$1</em>')
    .replace(/`([^`]+)`/g, '<code class="font-mono text-[0.9em] bg-[var(--paper-2)] px-1.5 py-0.5 rounded border border-[var(--line)]">$1</code>')
    .replace(/```([\s\S]*?)```/g, (_, code) =>
      `<pre class="my-3 overflow-auto rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] p-3 text-xs font-mono"><code>${escapeHtml(code)}</code></pre>`
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer" class="text-[var(--magenta-700)] underline hover:text-[var(--magenta-600)]">$1</a>')
    .replace(/^&gt; (.*)$/gm, '<blockquote class="my-2 border-l-2 border-[var(--saffron-500)] bg-[var(--saffron-50)]/50 py-1.5 pl-3 text-[var(--ink-2)]">$1</blockquote>')
    .replace(/^\s*[-*] (.*)$/gm, '<li class="ml-5 list-disc text-[var(--ink-2)]">$1</li>')
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, (m) => `<ul class="my-2 space-y-1">${m}</ul>`)
    .replace(/\n\n/g, '</p><p class="my-2 text-[var(--ink-2)]">')
    .replace(/^/, '<p class="text-[var(--ink-2)]">')
    .replace(/$/, "</p>");

  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(s: string | null) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function extFor(artifact: Artifact) {
  switch (artifact.type) {
    case "html": return "html";
    case "jsx":
    case "react": return artifact.language === "tsx" ? "tsx" : "jsx";
    case "svg": return "svg";
    case "markdown": return "md";
    default: return artifact.language || "txt";
  }
}

// ── Icons ────────────────────────────────────────────────────────────────
function CodeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function HtmlIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="4 17 8 7 12 17" />
      <polyline points="6 13 10 13" />
      <line x1="14" y1="7" x2="20" y2="17" />
      <line x1="20" y1="7" x2="14" y2="17" />
    </svg>
  );
}
function ReactIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="2" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}
function SvgIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
function MarkdownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 16V10l2 2 2-2v6" />
      <path d="M14 10v6m0 0l-2-2m2 2l2-2" />
    </svg>
  );
}
