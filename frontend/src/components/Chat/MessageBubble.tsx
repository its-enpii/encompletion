"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { Msg } from "./types";
import { authFetch } from "@/lib/auth";

const MarkdownView = dynamic(() => import("@/components/MarkdownView"), { ssr: false });

type Feedback = "like" | "dislike" | null;

export function MessageBubble({
  msg,
  sessionId,
  onRegenerate,
  attachments,
}: {
  msg: Msg;
  sessionId: number | null;
  onRegenerate?: () => void;
  attachments?: { file_name: string }[];
}) {
  const isUser = msg.role === "user";
  const [hovered, setHovered] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(
    (msg.feedback as Feedback | undefined) ?? null
  );
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!msg.content) return;
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  async function setFb(next: Feedback) {
    if (!sessionId || !msg.id || feedbackBusy) return;
    const prev = feedback;
    // Optimistic toggle: clicking the active thumb clears it, otherwise switch.
    const target: Feedback = feedback === next ? null : next;
    setFeedback(target);
    setFeedbackBusy(true);
    try {
      const r = await authFetch(
        `/api/sessions/${sessionId}/messages/${msg.id}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: target }),
        }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      // Revert on failure.
      setFeedback(prev);
    } finally {
      setFeedbackBusy(false);
    }
  }

  async function regenerate() {
    if (!sessionId || !msg.id || regenBusy || !onRegenerate) return;
    setRegenBusy(true);
    try {
      // Ask the backend to delete the assistant row + dependents. The parent
      // will then re-trigger the socket prompt with regenerate=true so the
      // existing user message is reused.
      const r = await authFetch(
        `/api/sessions/${sessionId}/messages/${msg.id}/regenerate`,
        { method: "POST" }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onRegenerate();
    } catch (e) {
      setRegenBusy(false);
    }
  }

  return (
    <div
      className="anim-slide-up group/msg relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {isUser ? (
        <div className="flex justify-end">
          <div className="relative max-w-[80%]">
            {msg.content ? (
              <div className="overflow-hidden rounded-[20px] rounded-br-md bg-gradient-to-br from-[var(--magenta-500)] to-[var(--magenta-700)] px-4 py-3 text-[14px] leading-relaxed text-white shadow-[0_2px_8px_rgba(168,71,129,0.25),inset_0_1px_0_rgba(255,255,255,0.15)]">
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              </div>
            ) : !attachments || attachments.length === 0 ? (
              // Pure-typing stream with no body yet.
              <div className="overflow-hidden rounded-[20px] rounded-br-md bg-gradient-to-br from-[var(--magenta-500)] to-[var(--magenta-700)] px-4 py-3 text-[14px] leading-relaxed text-white shadow-[0_2px_8px_rgba(168,71,129,0.25),inset_0_1px_0_rgba(255,255,255,0.15)]">
                <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
                <StreamingIndicator tone="user" />
              </div>
            ) : null}
            {/* User avatar indicator */}
            <div className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full bg-[var(--paper-3)] ring-2 ring-[var(--paper)] shadow-[var(--shadow-1)]">
              <span className="text-[10px] font-bold text-[var(--magenta-600)]">U</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex gap-3">
          {/* Brand avatar */}
          <div className="relative shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-[var(--saffron-200)] via-[var(--saffron-400)] to-[var(--saffron-500)] text-[var(--ink)] shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_2px_6px_rgba(232,162,43,0.25)]">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
                <path d="M12 2 L22 12 L12 22 L2 12 Z" />
              </svg>
            </div>
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--success)] ring-2 ring-[var(--paper)]" />
          </div>

          <div className="min-w-0 flex-1">
            {/* Assistant label + actions */}
            <div className="mb-1.5 flex items-center gap-2 text-[11px]">
              <span className="font-semibold text-[var(--ink)]">Asisten</span>
              <span className="text-[var(--ink-3)]">·</span>
              <span className="text-[var(--ink-3)]">baru saja</span>

              {/* Action buttons — visible on hover */}
              <div
                className={`flex items-center gap-0.5 transition-opacity ${
                  hovered || feedback || copied ? "opacity-100" : "opacity-0 focus-within:opacity-100"
                }`}
              >
                <BubbleAction
                  title={copied ? "Tersalin!" : "Salin"}
                  onClick={copy}
                  className={copied ? "!text-[var(--success)]" : ""}
                >
                  {copied ? (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </BubbleAction>
                <BubbleAction
                  title={feedback === "like" ? "Batalkan suka" : "Respons bagus"}
                  onClick={() => setFb("like")}
                  active={feedback === "like"}
                  disabled={feedbackBusy}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={feedback === "like" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                  </svg>
                </BubbleAction>
                <BubbleAction
                  title={feedback === "dislike" ? "Batalkan tidak suka" : "Respons kurang"}
                  onClick={() => setFb("dislike")}
                  active={feedback === "dislike"}
                  disabled={feedbackBusy}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill={feedback === "dislike" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                  </svg>
                </BubbleAction>
                <BubbleAction
                  title={regenBusy ? "Membuat ulang…" : "Buat ulang jawaban"}
                  onClick={regenerate}
                  disabled={regenBusy || !onRegenerate}
                  className={regenBusy ? "animate-spin" : ""}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                    <polyline points="21 3 21 8 16 8" />
                  </svg>
                </BubbleAction>
              </div>
            </div>

            {/* Bubble */}
            <div className="rounded-[20px] rounded-tl-md bg-[var(--paper-3)] px-5 py-3.5 text-[14px] leading-relaxed text-[var(--ink)] shadow-[var(--shadow-1)] ring-1 ring-inset ring-[var(--line)]">
              {msg.content ? (
                <MarkdownView content={msg.content} />
              ) : (
                // No text yet — engine is producing its first token or
                // running tools. Show the streaming dots in-place so the
                // user sees one bubble (avatar row + body) instead of
                // a phantom second pill at the bottom of the thread.
                <div className="flex items-center gap-2 text-xs text-[var(--ink-3)]">
                  <StreamingIndicator tone="assistant" />
                  <span>Sedang berpikir…</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function StreamingIndicator({ tone = "assistant" }: { tone?: "user" | "assistant" }) {
  const color = tone === "user" ? "bg-white/80" : "bg-[var(--saffron)]";
  return (
    <span className="inline-flex items-center gap-1.5 py-1" aria-label="Asisten sedang mengetik">
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
    </span>
  );
}

export function TypingPill() {
  return (
    <div className="anim-slide-up flex gap-3">
      <div className="relative shrink-0">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-[var(--saffron-200)] via-[var(--saffron-400)] to-[var(--saffron-500)] text-[var(--ink)] shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_2px_6px_rgba(232,162,43,0.25)]">
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current">
            <path d="M12 2 L22 12 L12 22 L2 12 Z" />
          </svg>
        </div>
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--saffron-300)] ring-2 ring-[var(--paper)]" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-[var(--ink)]">Asisten</span>
          <span className="text-[var(--ink-3)]">· sedang berpikir…</span>
        </div>
        <div className="rounded-[20px] rounded-tl-md bg-[var(--paper-3)] px-5 py-3.5 shadow-[var(--shadow-1)] ring-1 ring-inset ring-[var(--line)]">
          <div className="flex items-center gap-2 text-xs text-[var(--ink-3)]">
            <StreamingIndicator tone="assistant" />
            <span>Sedang berpikir…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BubbleAction({
  title,
  onClick,
  children,
  active,
  disabled,
  className = "",
}: {
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-6 w-6 place-items-center rounded-[6px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-[var(--magenta-50)] text-[var(--magenta-700)] hover:bg-[var(--magenta-100)]"
          : "text-[var(--ink-3)] hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)]"
      } ${className}`}
    >
      {children}
    </button>
  );
}