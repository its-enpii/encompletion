"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import type { PendingAtt } from "./types";
import type { Project } from "@/components/Sidebar/types";
import { AttachmentTile } from "./AttachmentTile";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  pendingAtts: PendingAtt[];
  onRemoveAtt: (idx: number) => void;
  onAttach: () => void;
  onPickProject: (id: number | null) => void;
  projects: Project[];
  currentProjectId: number | null;
  onManageSkills: () => void;
  // Drag-drop target. Called with the native FileList from a drop or
  // paste event so the parent can upload each file via the existing
  // /api/attachments pipeline. Composer still calls onAttach (which
  // opens the file picker) for the toolbar Attach button.
  onFiles: (files: FileList) => void;
};

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  pendingAtts,
  onRemoveAtt,
  onAttach,
  onPickProject,
  projects,
  currentProjectId,
  onManageSkills,
  onFiles,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Local drag state — only the composer wrapper reacts to dragover/
  // dragleave so the page-level overlay (in Chat/index.tsx) handles
  // drops outside the composer box.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const max = 280;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [value]);

  const canSend = !streaming && (value.trim().length > 0 || pendingAtts.length > 0);
  const charCount = value.length;

  function onDragEnter(e: React.DragEvent) {
    if (streaming) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDragOver(e: React.DragEvent) {
    // Required so `drop` fires — without preventDefault the browser
    // treats the composer as a non-drop target and opens the file in
    // the tab instead of handing the FileList to our handler.
    if (streaming) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) onFiles(files);
  }

  return (
    <div className="border-t border-[var(--line)] bg-gradient-to-t from-[var(--paper-2)] to-[var(--paper)] px-3 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {pendingAtts.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-2 anim-fade-in">
            {pendingAtts.map((a, i) => (
              <AttachmentTile
                key={i}
                att={a}
                onRemove={() => onRemoveAtt(i)}
              />
            ))}
          </div>
        )}

        <div
          className={`group/composer relative overflow-hidden rounded-[22px] border bg-[var(--paper-3)] shadow-[var(--shadow-2)] transition-[box-shadow,border-color] duration-150 focus-within:border-[var(--magenta-300)] focus-within:shadow-[0_0_0_3px_rgba(168,71,129,0.14)] ${
            dragging
              ? "border-[var(--magenta)] shadow-[0_0_0_3px_rgba(168,71,129,0.18)]"
              : "border-[var(--line)]"
          }`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[22px] bg-[var(--magenta-50)]/85 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-full border border-[var(--magenta)] bg-[var(--paper-3)] px-3 py-1.5 text-xs font-medium text-[var(--magenta-700)] shadow-[var(--shadow-2)]">
                <PaperclipIcon className="h-3.5 w-3.5" />
                Drop files to attach
              </div>
            </div>
          )}
          <div className="relative">
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) onSend();
                }
              }}
              onPaste={(e) => {
                // Paste a screenshot from the clipboard directly as an
                // attachment. Plain text pastes go through the default
                // handler so the user's existing copy-paste flow stays
                // intact.
                const items = e.clipboardData?.items;
                if (!items) return;
                const files: File[] = [];
                for (const it of Array.from(items)) {
                  if (it.kind === "file") {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                  }
                }
                if (files.length === 0) return;
                e.preventDefault();
                const dt = new DataTransfer();
                for (const f of files) dt.items.add(f);
                onFiles(dt.files);
              }}
              placeholder={streaming ? "Sedang berpikir…" : "Tulis pesan… tekan Enter untuk kirim, Shift+Enter untuk baris baru"}
              rows={1}
              disabled={streaming}
              className="block w-full resize-none bg-transparent px-5 pb-3 pt-4 text-[14px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none disabled:opacity-60"
            />

            {/* Char counter top-right */}
            <div className="pointer-events-none absolute right-4 top-3 select-none text-[10px] font-mono text-[var(--ink-4)]">
              {charCount > 0 ? `${charCount.toLocaleString()}` : ""}
            </div>
          </div>

          {/* Footer toolbar */}
          <div className="flex items-center gap-1 border-t border-[var(--line)] bg-[var(--paper-2)]/80 px-2 py-1.5 backdrop-blur-sm">
            <Button variant="ghost" size="sm" onClick={onAttach} disabled={streaming}>
              <PaperclipIcon className="h-3.5 w-3.5" />
              <span>Attach</span>
            </Button>

            <ProjectPick
              projects={projects}
              currentProjectId={currentProjectId}
              onPick={onPickProject}
            />

            <Button variant="ghost" size="sm" onClick={onManageSkills}>
              <SparkleIcon className="h-3.5 w-3.5" />
              <span>Skills</span>
            </Button>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden items-center gap-1 text-[11px] text-[var(--ink-3)] sm:inline-flex">
                <kbd className="kbd">⇧</kbd>
                <kbd className="kbd">⏎</kbd>
                <span>newline</span>
              </span>
              {streaming ? (
                <Button variant="danger" size="sm" onClick={onStop}>
                  <span className="grid h-3 w-3 place-items-center rounded-sm bg-white" />
                  <span>Stop</span>
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={onSend} disabled={!canSend}>
                  <span>Send</span>
                  <kbd className="kbd ml-1 !bg-[var(--magenta-700)] !border-[var(--magenta-700)] !text-white/90">
                    ⏎
                  </kbd>
                </Button>
              )}
            </div>
          </div>
        </div>

        <p className="mt-2 text-center text-[11px] text-[var(--ink-3)]">
          AI dapat membuat kesalahan · Verifikasi info penting
        </p>
      </div>
    </div>
  );
}

function ProjectPick({
  projects,
  currentProjectId,
  onPick,
}: {
  projects: Project[];
  currentProjectId: number | null;
  onPick: (id: number | null) => void;
}) {
  const current = projects.find((p) => p.id === currentProjectId);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    placement: "above" | "below";
    maxHeight: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const margin = 6;
      const vh = window.innerHeight;
      const spaceBelow = vh - r.bottom - margin; // available BELOW trigger
      const spaceAbove = r.top - margin;         // available ABOVE trigger
      // Smart flip: prefer BELOW the trigger (natural reading order).
      // When flipping ABOVE, we anchor the popover so its BOTTOM edge sits
      // `margin` pixels above the trigger's TOP edge — never the trigger's
      // bottom — so the trigger button is left entirely outside the popover
      // and remains clickable. Above-placement height is the available
      // space MINUS the trigger height so the popover can never grow back
      // over the trigger itself.
      const MIN_USABLE = 200;
      const flipToAbove = spaceBelow < MIN_USABLE && spaceAbove >= MIN_USABLE;
      if (flipToAbove) {
        // Use `bottom: vh - r.top + margin` so the popover's bottom edge
        // lands exactly `margin` px above the trigger's top edge. The
        // popover grows upward from there; cap to spaceAbove-m so it never
        // reaches the trigger.
        setPos({
          left: r.left,
          bottom: vh - r.top + margin,
          placement: "above",
          maxHeight: Math.max(160, spaceAbove - margin),
        });
      } else {
        setPos({
          left: r.left,
          top: r.bottom + margin,
          placement: "below",
          maxHeight: Math.min(480, Math.max(160, spaceBelow - 4)),
        });
      }
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (!(t as HTMLElement).closest?.("[data-project-popover]")) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--r-md)] border px-2.5 text-xs font-medium transition-all ${
          open
            ? "border-[var(--magenta)] bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-focus)]"
            : current
              ? "border-[var(--line)] bg-[var(--paper-3)] text-[var(--ink)]"
              : "border-transparent text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
        }`}
      >
        {current ? (
          <>
            <span
              className="h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-black/10"
              style={{ background: current.color }}
              aria-hidden
            />
            <span className="max-w-[120px] truncate">{current.name}</span>
            <PillXIcon className="h-3 w-3 opacity-60 hover:opacity-100" onClick={(e) => { e.stopPropagation(); onPick(null); }} />
          </>
        ) : (
          <>
            <PlusIcon className="h-3.5 w-3.5" />
            <span>No project</span>
          </>
        )}
        <ChevronIcon className={`h-3 w-3 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <ul
          data-project-popover
          role="listbox"
          style={{
            left: pos.left,
            ...(pos.placement === "above"
              ? { bottom: pos.bottom }
              : { top: pos.top }),
            maxHeight: pos.maxHeight,
          }}
          className="anim-scale-in fixed z-[1000] flex w-72 flex-col overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] py-1 shadow-[var(--shadow-4)]"
        >
          <div className="border-b border-[var(--line)] bg-[var(--paper-2)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
            Pilih project
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <li>
            <button
              type="button"
              onClick={() => { onPick(null); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                currentProjectId == null
                  ? "bg-[var(--magenta-50)] text-[var(--magenta-700)]"
                  : "text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
              }`}
            >
              <span className="grid h-6 w-6 place-items-center rounded border border-dashed border-[var(--line-strong)] text-[var(--ink-3)]">
                <PlusIcon className="h-3 w-3 rotate-45" />
              </span>
              <span className="flex-1">No project</span>
              {currentProjectId == null && <CheckIcon className="h-3.5 w-3.5 text-[var(--magenta-600)]" />}
            </button>
          </li>
          {projects.length === 0 ? (
            <li className="px-3 py-3 text-center text-[12px] text-[var(--ink-3)]">
              Belum ada project
            </li>
          ) : (
            projects.map((p) => {
              const isSel = p.id === currentProjectId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => { onPick(p.id); setOpen(false); }}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors ${
                      isSel
                        ? "bg-[var(--magenta-50)] text-[var(--magenta-700)]"
                        : "text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
                      style={{ background: p.color }}
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                    {isSel && <CheckIcon className="h-3.5 w-3.5 text-[var(--magenta-600)]" />}
                  </button>
                </li>
              );
            })
          )}
          </div>
        </ul>,
        document.body
      )}
    </div>
  );
}

function PaperclipIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function SparkleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" />
    </svg>
  );
}
function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function ChevronIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function PillXIcon({ className, onClick }: { className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" onClick={onClick} className={className}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    </button>
  );
}