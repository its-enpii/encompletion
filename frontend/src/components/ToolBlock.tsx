"use client";

import { useState } from "react";
import { Pill } from "@/components/ui/Pill";

export type ToolUse = {
  id: number;
  message_id: number;
  tool_use_id?: string;
  tool_name: string;
  input?: string | null;
  output?: string | null;
  is_error: number;
  duration_ms?: number | null;
};

const ICONS: Record<string, string> = {
  Bash: "⚡",
  Read: "📖",
  Write: "✏️",
  Edit: "✏️",
  Glob: "🔍",
  Grep: "🔍",
  WebSearch: "🌐",
  WebFetch: "🌐",
  PowerShell: "💻",
  Task: "🤖",
};

function pickIcon(name: string) {
  for (const [k, v] of Object.entries(ICONS)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "🔧";
}

function tryParse(s?: string | null) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export default function ToolBlock({ tool }: { tool: ToolUse }) {
  const [open, setOpen] = useState(false);
  const input = tryParse(tool.input);
  const outStr = tool.output ?? "";
  const err = !!tool.is_error;

  return (
    <div
      className={`overflow-hidden rounded-[var(--r-md)] border ring-1 ring-inset transition-shadow ${
        err
          ? "border-[var(--danger)]/30 bg-[var(--danger-50)]/50 ring-[var(--danger)]/10"
          : "border-[var(--line)] bg-[var(--paper-3)] ring-[var(--line)]"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--paper-2)]"
      >
        <div className="flex min-w-0 items-center gap-2 truncate">
          <span className="text-base">{pickIcon(tool.tool_name)}</span>
          <Pill tone={err ? "danger" : "neutral"}>{tool.tool_name}</Pill>
          {input && typeof input === "object" && "command" in input && (
            <code className="truncate rounded bg-[var(--paper-2)] px-2 py-0.5 font-mono text-xs text-[var(--ink-2)]">
              $ {String((input as any).command).slice(0, 80)}
            </code>
          )}
          {input && typeof input === "object" && "file_path" in input && (
            <code className="truncate rounded bg-[var(--paper-2)] px-2 py-0.5 font-mono text-xs text-[var(--ink-2)]">
              {String((input as any).file_path)}
            </code>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--ink-3)]">
          {tool.duration_ms != null && (
            <span className="font-mono text-[var(--saffron-500)]">{(tool.duration_ms / 1000).toFixed(2)}s</span>
          )}
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="border-t border-[var(--line)] bg-[var(--paper-2)] px-3 py-2 text-xs anim-fade-in">
          {input !== null && (
            <div className="mb-2">
              <div className="mb-1 label">Input</div>
              <pre className="max-h-60 overflow-auto rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-3)] p-2 font-mono text-[11px] text-[var(--ink)]">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {outStr && (
            <div>
              <div className="mb-1 label">
                Output{err && <span className="ml-1 text-[var(--danger)]">[error]</span>}
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-3)] p-2 font-mono text-[11px] text-[var(--ink-2)]">
                {outStr.slice(0, 8000)}
                {outStr.length > 8000 && "\n…(truncated)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}