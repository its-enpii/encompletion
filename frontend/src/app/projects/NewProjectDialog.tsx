"use client";

import { useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

const DEFAULT_COLOR = "#A84781";

const SWATCHES = [
  "#A84781", // magenta (default)
  "#E8A22B", // saffron
  "#2F8F5A", // success
  "#2B6FB6", // info
  "#7E57C2", // violet
  "#EF6C57", // coral
  "#1A1410", // ink
  "#5D6D7E", // slate
];

export function NewProjectDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: { name: string; description: string | null; color: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), description: description.trim() || null, color });
      setName(""); setDescription(""); setColor(DEFAULT_COLOR);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Gagal membuat project");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Project baru"
      description="Kelompokkan session berdasarkan topik. Instructions & knowledge akan di-inject ke system prompt saat session dimulai."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button variant="primary" onClick={submit} disabled={!name.trim() || busy}>
            {busy ? "Membuat…" : "Buat project"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField
          label="Nama"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. SIDBM, Laundry SaaS…"
          autoFocus
        />
        <TextField
          as="textarea"
          label="Deskripsi"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ringkasan singkat project (opsional)"
          rows={2}
        />
        <div>
          <label className="label mb-2 block">Color</label>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1.5">
              {SWATCHES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setColor(s)}
                  aria-label={`Color ${s}`}
                  className={`grid h-7 w-7 place-items-center rounded-full transition-transform hover:scale-110 ${
                    color === s ? "ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--paper-3)]" : ""
                  }`}
                  style={{ background: s }}
                >
                  {color === s && (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-white" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="font-mono text-xs text-[var(--ink-3)]">{color}</span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-7 w-7 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0"
              />
            </div>
          </div>
        </div>
        {error && (
          <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}