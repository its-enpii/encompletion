"use client";

import { useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/** Two-step delete — same pattern as DeleteProjectDialog for consistency. */
export function DeleteUserDialog({
  open,
  username,
  onClose,
  onConfirm,
}: {
  open: boolean;
  username: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Gagal menghapus");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Hapus user?"
      description={`Tindakan ini permanen — user "${username}" tidak akan bisa login lagi.`}
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Batal</Button>
          <Button variant="danger" onClick={doDelete} disabled={busy}>
            {busy ? "Menghapus…" : "Hapus permanen"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      <p className="text-sm text-[var(--ink-2)]">
        Karena hapus user bisa berakibat pada orphaned sessions, mohon konfirmasi dengan teliti.
      </p>
    </CenteredDialog>
  );
}