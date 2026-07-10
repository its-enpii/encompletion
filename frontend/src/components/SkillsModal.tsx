"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { TextField } from "@/components/ui/TextField";

type SkillFile = { name: string; size: number };
type Skill = {
  name: string;
  description: string | null;
  frontmatter: string | null;
  size: number;
  updated_at: string;
  files: SkillFile[];
};

type EditorState = {
  creating: boolean;
  name: string;
  content: string;
  // Supporting files visible in the editor scope. Reset on save;
  // reloaded from the new skill row's `files` once the modal closes.
  uploadedFiles: SkillFile[];
};

type Props = { onClose: () => void };

const FRONTMATTER_DOC = `---
description: One-line summary of what this skill does and when to use it
---

# Skill instructions

Write the procedure, checklist, or domain knowledge here.

You can reference supporting files in the same folder, e.g. \`examples/sample.md\`.
`;

/**
 * Skills manager — managed at the engine's home skills directory.
 * Opens from the composer without project context.
 */
export default function SkillsModal({ onClose }: Props) {
  const { confirm } = useUi();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [root, setRoot] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await authFetch("/api/skills").then((r) => r.json());
      setSkills(d.skills || []);
      setRoot(d.root || "");
    } catch (e: any) {
      setError(e?.message || "failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function startCreate() {
    setEditing({ creating: true, name: "", content: FRONTMATTER_DOC, uploadedFiles: [] });
    setError(null);
  }
  function startEdit(s: Skill) {
    setEditing({ creating: false, name: s.name, content: s.frontmatter ?? "", uploadedFiles: s.files });
    setError(null);
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      if (editing.creating) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(editing.name)) {
          setError("Name: use letters, digits, . _ - (start with letter/digit)");
          setBusy(false);
          return;
        }
        const r = await authFetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: editing.name, content: editing.content }),
        });
        if (!r.ok) throw new Error((await r.json()).error || "create failed");
      } else {
        const r = await authFetch(`/api/skills/${encodeURIComponent(editing.name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editing.content }),
        });
        if (!r.ok) throw new Error((await r.json()).error || "save failed");
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "save failed");
    } finally {
      setBusy(false);
    }
  }

  // Upload (or, for zip/rar, extract-into) a supporting file.
  // Uses POST /api/skills/:name/files with a base64 payload. The
  // backend transparently detects zip magic bytes and extracts
  // into the skill folder; otherwise writes a single file.
  async function uploadFile(file: File) {
    if (!editing) return;
    if (editing.creating) {
      setError("Simpan skill dulu sebelum tambah file pendukung.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await authFetch(
        `/api/skills/${encodeURIComponent(editing.name)}/files`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataBase64: b64, name: file.name }),
        }
      );
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      // Backend returns the fresh file list when extraction happens,
      // otherwise just the new file entry. Coalesce into local state.
      if (Array.isArray(data.files)) {
        setEditing({ ...editing, uploadedFiles: data.files });
      } else if (data.file) {
        setEditing({
          ...editing,
          uploadedFiles: [...editing.uploadedFiles.filter((f) => f.name !== data.file.name), data.file],
        });
      }
      await load();
    } catch (e: any) {
      setError(e?.message || "upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(name: string) {
    if (!editing) return;
    const ok = await confirm({
      title: "Hapus file",
      message: `Hapus file "${name}" dari skill ini?`,
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/skills/${encodeURIComponent(editing.name)}/files/${encodeURIComponent(name)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setEditing({ ...editing, uploadedFiles: editing.uploadedFiles.filter((f) => f.name !== name) });
      await load();
    } catch (e: any) {
      setError(e?.message || "delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    const ok = await confirm({
      title: "Hapus skill",
      message: `Hapus skill "${name}"? Folder dan semua file di dalamnya akan hilang.`,
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error || "delete failed");
      await load();
    } catch (e: any) {
      setError(e?.message || "delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <CenteredDialog
        open
        onClose={() => { if (!busy) { setEditing(null); setError(null); } }}
        title={editing.creating ? "Tambah skill" : `Edit: ${editing.name}`}
        widthClass="max-w-4xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditing(null); setError(null); }} disabled={busy}>
              Batal
            </Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              {busy ? "Menyimpan…" : editing.creating ? "Buat" : "Simpan"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {editing.creating && (
            <TextField
              label="Nama skill"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="nama-skill"
              autoFocus
            />
          )}
          {error && (
            <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
              {error}
            </div>
          )}
          <div>
            <label className="label mb-1.5 block">SKILL.md</label>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              className="input h-[40vh] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
          </div>

          {/* Supporting files. Hidden in the create flow until the row
              exists; for the edit flow we surface everything the
              server currently exposes for this skill. Drop a .zip
              to bulk-load a folder; any other file goes straight
              under the skill folder at the basename. */}
          <div className="border-t border-[var(--line)] pt-3">
            <div className="mb-2 flex items-center justify-between">
              <label className="label">File pendukung</label>
              {!editing.creating && (
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-2 py-1 text-[11px] text-[var(--ink-2)] transition-colors hover:border-[var(--magenta)]/40 hover:bg-[var(--paper-3)] hover:text-[var(--ink)]">
                  <input
                    type="file"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadFile(f);
                      e.currentTarget.value = "";
                    }}
                  />
                  Tambah file…
                </label>
              )}
            </div>

            {!editing.creating && (
              <div
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f) uploadFile(f);
                }}
                className="rounded-[var(--r-md)] border border-dashed border-[var(--line)] bg-[var(--paper-2)]/40 px-3 py-3 text-center text-[11px] text-[var(--ink-3)] transition-colors hover:border-[var(--magenta)]/40 hover:text-[var(--ink-2)]"
              >
                Drop file di sini (.zip untuk auto-extract)
              </div>
            )}

            {editing.uploadedFiles.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)]/50 p-2">
                {editing.uploadedFiles.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--paper-3)] px-2.5 py-1.5 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[var(--ink-3)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="truncate font-mono text-[var(--ink-2)]">{f.name}</span>
                      <span className="shrink-0 text-[var(--ink-3)]">
                        {(f.size / 1024).toFixed(1)} KB
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => deleteFile(f.name)}
                      className="rounded-[var(--r-sm)] px-1.5 py-0.5 text-[11px] text-[var(--ink-3)] transition-colors hover:bg-[var(--danger-50)] hover:text-[var(--danger)] disabled:opacity-50"
                    >
                      Hapus
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CenteredDialog>
    );
  }

  return (
    <CenteredDialog
      open
      onClose={onClose}
      title="Skills"
      description={root ? `${skills.length} skill · ${root}` : `${skills.length} skill`}
      widthClass="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Tutup</Button>
          <Button variant="primary" onClick={startCreate}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Tambah skill</span>
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {loading ? (
        <div className="py-12 text-center text-sm text-[var(--ink-3)]">Memuat…</div>
      ) : skills.length === 0 ? (
        <div className="py-12 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[var(--saffron-50)] text-[var(--saffron-500)]">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M12 2 L22 12 L12 22 L2 12 Z" />
            </svg>
          </div>
          <div className="mt-3 text-sm font-medium text-[var(--ink)]">Belum ada skill</div>
          <div className="mt-1 text-xs text-[var(--ink-3)]">Tambah skill pertamamu untuk mulai.</div>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {skills.map((s) => (
            <li
              key={s.name}
              className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] p-3 transition-colors hover:border-[var(--line-strong)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Pill tone="saffron">{s.name}</Pill>
                  <span className="text-xs text-[var(--ink-3)]">
                    {new Date(s.updated_at).toLocaleString("id-ID")}
                  </span>
                </div>
                {s.description && (
                  <p className="mt-1.5 line-clamp-2 text-sm text-[var(--ink-2)]">{s.description}</p>
                )}
                <p className="mt-1 text-xs text-[var(--ink-3)]">
                  {(s.size / 1024).toFixed(1)} KB · {s.files.length} file
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" onClick={() => startEdit(s)}>Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => remove(s.name)} disabled={busy}>
                  <span className="text-[var(--danger)]">Hapus</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </CenteredDialog>
  );
}