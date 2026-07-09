"use client";

import { useEffect, useRef, useState } from "react";
import type { Project } from "./Sidebar";

type Props = {
  pendingCount: number;
  projects: Project[];
  currentProjectId: number | null;
  onPickFiles: () => void;
  onCapturePhoto: () => void;
  onSelectProject: (id: number | null) => void;
  onManageSkills: () => void;
};

export default function AttachMenu({
  pendingCount,
  projects,
  currentProjectId,
  onPickFiles,
  onCapturePhoto,
  onSelectProject,
  onManageSkills,
}: Props) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => { if (!open) setSubOpen(false); }, [open]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      e.preventDefault();
    }
  }

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Attach file or manage attachments"
        className={`inline-flex h-7 items-center gap-1.5 rounded-[var(--r-md)] border px-2.5 text-xs font-medium transition-colors ${
          open || pendingCount > 0
            ? "border-[var(--saffron)] bg-[var(--saffron-50)] text-[var(--saffron-500)]"
            : "border-transparent text-[var(--ink-2)] hover:bg-[var(--paper-3)] hover:text-[var(--ink)]"
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        <span>Attach</span>
        {pendingCount > 0 && (
          <span className="ml-0.5 grid min-w-4 place-items-center rounded-full bg-[var(--saffron)] px-1 text-[10px] font-bold text-[var(--ink)]">
            {pendingCount}
          </span>
        )}
      </button>
      {open && (
        <ul
          role="menu"
          className="anim-scale-in absolute bottom-full left-0 z-50 mb-1.5 w-60 overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] py-1 shadow-[var(--shadow-4)]"
        >
          <Item
            icon={<FolderOpenIcon className="h-3.5 w-3.5" />}
            label="Pilih file / gambar"
            hint="multiple"
            onClick={() => { onPickFiles(); setOpen(false); }}
          />
          <Item
            icon={<CameraIcon className="h-3.5 w-3.5" />}
            label="Ambil foto"
            hint="camera"
            onClick={() => { onCapturePhoto(); setOpen(false); }}
          />
          <li className="relative" onMouseEnter={() => setSubOpen(true)} onMouseLeave={() => setSubOpen(false)}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={subOpen}
              onClick={() => setSubOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
            >
              <span className="flex items-center gap-2.5">
                <span className="text-[var(--saffron-500)]"><FolderIcon className="h-3.5 w-3.5" /></span>
                <span>Masukkan ke project</span>
              </span>
              <span className="text-[10px] text-[var(--ink-3)]">
                {currentProjectId ? `#${currentProjectId}` : "none"}
              </span>
            </button>
            {subOpen && (
              <ul className="anim-scale-in absolute left-full top-0 z-50 ml-1 w-56 overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] py-1 shadow-[var(--shadow-4)]">
                <SubItem
                  icon={<NoProjectIcon className="h-3.5 w-3.5" />}
                  label="No project"
                  active={currentProjectId == null}
                  onClick={() => { onSelectProject(null); setOpen(false); }}
                />
                {projects.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-[var(--ink-3)]">Belum ada project</li>
                ) : (
                  projects.map((p) => (
                    <SubItem
                      key={p.id}
                      icon={<SwatchIcon color={p.color} className="h-3 w-3" />}
                      label={p.name}
                      active={currentProjectId === p.id}
                      onClick={() => { onSelectProject(p.id); setOpen(false); }}
                    />
                  ))
                )}
              </ul>
            )}
          </li>
          <div className="my-1 mx-2 border-t border-[var(--line)]" />
          <Item
            icon={<SparkleIcon className="h-3.5 w-3.5" />}
            label="Manajemen skills"
            onClick={() => { onManageSkills(); setOpen(false); }}
          />
        </ul>
      )}
    </div>
  );
}

function Item({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
      >
        <span className="flex items-center gap-2.5">
          <span className="text-[var(--saffron-500)]">{icon}</span>
          <span>{label}</span>
        </span>
        {hint && <span className="rounded-full bg-[var(--paper-2)] px-1.5 py-0.5 text-[10px] text-[var(--ink-3)]">{hint}</span>}
      </button>
    </li>
  );
}

function SubItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        aria-selected={active}
        onClick={onClick}
        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors ${
          active
            ? "bg-[var(--magenta-50)] text-[var(--magenta-700)]"
            : "text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
        }`}
      >
        <span className="w-3.5 shrink-0">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {active && (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[var(--magenta-600)]" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </button>
    </li>
  );
}

function FolderOpenIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function FolderIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function CameraIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
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
function NoProjectIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}
function SwatchIcon({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={className}
      style={{
        background: color,
        borderRadius: "9999px",
        display: "inline-block",
        width: "0.75rem",
        height: "0.75rem",
      }}
    />
  );
}