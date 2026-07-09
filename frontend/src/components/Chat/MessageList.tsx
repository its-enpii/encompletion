"use client";

import { useEffect, useRef } from "react";
import ToolBlock, { type ToolUse } from "@/components/ToolBlock";
import { MessageBubble, TypingPill } from "./MessageBubble";
import { JumpToBottom } from "./JumpToBottom";
import type { Att, Msg } from "./types";

export function MessageList({
  messages,
  toolUses,
  attachmentsByMsg,
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
  streaming: boolean;
  showJump: boolean;
  onScroll: (gap: number) => void;
  onJump: () => void;
  mainScrollRef: React.RefObject<HTMLDivElement | null>;
  sessionId: number | null;
  onRegenerate?: (assistantMsgId: number) => void;
}) {
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
                <AttachmentStrip atts={attachmentsByMsg[m.id]} align={m.role === "user" ? "right" : "left"} showIndent={!showAvatar && m.role === "assistant"} />
              ) : null}
              <div className={showAvatar ? "" : "pl-12"}>
                <MessageBubble msg={m} sessionId={sessionId} onRegenerate={m.role === "assistant" && onRegenerate ? () => onRegenerate(m.id) : undefined} />
              </div>
              {m.role === "assistant" &&
                toolUses
                  .filter((t) => t.message_id === m.id)
                  .map((t) => (
                    <div key={t.tool_use_id || t.id} className={showAvatar ? "pl-12" : "pl-12"}>
                      <ToolBlock tool={t} />
                    </div>
                  ))}
            </div>
          );
        })}
        {streaming && messages[messages.length - 1]?.content === "" && <TypingPill />}
        <div className="h-6" />
      </div>
      {showJump && <JumpToBottom onClick={onJump} />}
    </div>
  );
}

function AttachmentStrip({ atts, align, showIndent }: { atts: Att[]; align: "left" | "right"; showIndent?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${align === "right" ? "justify-end" : "pl-12"}`}>
      {atts.map((a) => (
        <a
          key={a.id}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="group/att inline-flex items-center gap-2 rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--paper-3)] py-1 pl-2.5 pr-3 text-xs text-[var(--ink-2)] shadow-[var(--shadow-1)] transition-all hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:text-[var(--ink)] hover:shadow-[var(--shadow-2)]"
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--paper-4)] text-[var(--ink-3)] transition-colors group-hover/att:bg-[var(--saffron-50)] group-hover/att:text-[var(--saffron-500)]">
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </span>
          <span className="max-w-[200px] truncate">{a.file_name}</span>
        </a>
      ))}
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

      <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-[var(--ink-4)]">
        Powered by Encompletion · Opus 4.6
      </p>
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