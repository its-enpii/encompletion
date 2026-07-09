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

// Permissive model key. Admin-only field — the operator knows what shape
// their CLI expects and what historical sessions reference. We don't
// rewrite user input; we only block patterns that break shell parsing or
// the registration protocol:
//   - empty string
//   - leading or trailing whitespace
//
// Anything else — dots, slashes, colons, backslashes, dashes, underscores,
// provider/model paths, the lot — is left to the operator to author. If
// the CLI rejects the key down the line, that's a runtime problem
// (caught at prompt time) not a registration problem.
const KEY_RE = /^\S+$/;

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

  function validateKey(raw: string): string | null {
    if (!raw || !raw.trim()) return "Key wajib diisi";
    if (/\s/.test(raw)) return "Key tidak boleh mengandung spasi atau baris baru";
    return null;
  }

  async function save() {
    setError(null);
    if (!isEdit) {
      const err = validateKey(key);
      if (err) { setError(err); return; }
    }
    if (!label.trim()) {
      setError("Label wajib diisi");
      return;
    }
    const payload: ModelPayload = { label: label.trim() };
    if (!isEdit) {
      payload.key = key.trim();
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
      description="Key dikirim ke backend engine via CLI flag. Bebas karakter apapun selama non-kosong dan tanpa spasi."
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
            onChange={(e) => setKey(e.target.value)}
            placeholder="workspace atau provider/model-name"
            autoFocus
            hint="Karakter apapun kecuali spasi. Contoh: provider/model-name atau custom.id"
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
