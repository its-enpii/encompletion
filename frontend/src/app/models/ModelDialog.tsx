"use client";

import { useEffect, useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

export type Model = {
  id: number;
  key: string;
  label: string;
  enabled?: boolean;
  sort_order?: number;
  created_at?: string;
  updated_at?: string | null;
};

export type ModelPayload = {
  key?: string;
  label?: string;
  enabled?: boolean;
  sort_order?: number;
};

type Props = {
  value:
    | { kind: "create" }
    | { kind: "edit"; model: Model }
    | null;
  onClose: () => void;
  onSubmit: (payload: ModelPayload) => Promise<void>;
};

const KEY_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function ModelDialog({ value, onClose, onSubmit }: Props) {
  const isEdit = !!value && value.kind === "edit";
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [sortOrder, setSortOrder] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) return;
    setError(null);
    if (value.kind === "edit") {
      setKey(value.model.key);
      setLabel(value.model.label);
      setEnabled(value.model.enabled !== false);
      setSortOrder(value.model.sort_order ?? 0);
    } else {
      setKey("");
      setLabel("");
      setEnabled(true);
      setSortOrder(0);
    }
  }, [value]);

  if (!value) return null;

  async function save() {
    setError(null);
    if (!isEdit && !KEY_RE.test(key)) {
      setError("Key harus lowercase kebab-case, mis. claude-sonnet-4-6");
      return;
    }
    if (!label.trim()) {
      setError("Label wajib diisi");
      return;
    }
    const payload: ModelPayload = { label: label.trim() };
    if (!isEdit) {
      payload.key = key.trim().toLowerCase();
      payload.enabled = enabled;
      payload.sort_order = sortOrder;
    } else {
      // Edit supports enabling/disabling and re-sorting. Key rename happens
      // via a dedicated inline edit below.
      payload.enabled = enabled;
      payload.sort_order = sortOrder;
    }
    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (e: any) {
      setError(e?.message || "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={isEdit ? `Edit model: ${(value as any).model.label}` : "Tambah model"}
      description="Key dikirim ke backend engine via CLI flag. Label tampil di dropdown."
      widthClass="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? "Menyimpan…" : isEdit ? "Simpan" : "Buat"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!isEdit && (
          <TextField
            label="Key (CLI flag)"
            value={key}
            onChange={(e) => setKey(e.target.value.trim().toLowerCase())}
            placeholder="workspace"
            autoFocus
            hint="lowercase kebab-case, contoh: opus-4-8 atau workspace"
          />
        )}
        <TextField
          label="Label (tampil di dropdown)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Workspace"
        />
        <div className="flex items-center gap-4">
          <label className="flex flex-1 items-center gap-2 text-sm text-[var(--ink-2)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[var(--magenta)]"
            />
            Enabled (muncul di dropdown)
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--ink-2)]">
            <span>Sort</span>
            <input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              min={0}
              max={10000}
              className="w-20 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--paper-3)] px-2 py-1 text-sm focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
            />
          </label>
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
