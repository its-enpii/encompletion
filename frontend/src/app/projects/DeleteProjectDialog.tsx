"use client";

import { useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

/**
 * Two-step delete confirmation. Step 1: confirm the action.
 * Step 2: type the project name to verify — only when the project has sessions.
 */
export function DeleteProjectDialog({
  open,
  projectName,
  sessionCount,
  onClose,
  onConfirm,
}: {
  open: boolean;
  projectName: string;
  sessionCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [step, setStep] = useState<"confirm" | "verify">("confirm");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("confirm");
    setTyped("");
    setError(null);
    setBusy(false);
  }

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      reset();
      onClose();
    } catch (e: any) {
      setError(e?.message || "Gagal menghapus");
    } finally {
      setBusy(false);
    }
  }

  const needsVerify = sessionCount > 0;

  return (
    <CenteredDialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title={step === "confirm" ? "Hapus project?" : "Konfirmasi sekali lagi"}
      description={
        step === "confirm"
          ? `Project "${projectName}" akan dihapus. ${needsVerify ? `Karena masih ada ${sessionCount} session, kita perlu konfirmasi tambahan.` : ""}`
          : `Ketik "${projectName}" untuk melanjutkan.`
      }
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>
            Batal
          </Button>
          {step === "confirm" ? (
            <Button variant="danger" onClick={() => needsVerify ? setStep("verify") : doDelete()} disabled={busy}>
              {needsVerify ? "Lanjut →" : "Hapus"}
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={doDelete}
              disabled={busy || typed.trim() !== projectName}
            >
              {busy ? "Menghapus…" : "Hapus permanen"}
            </Button>
          )}
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {step === "verify" && (
        <TextField
          label="Ketik nama project untuk konfirmasi"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={projectName}
          autoFocus
        />
      )}
      {step === "confirm" && (
        <p className="text-sm text-[var(--ink-2)]">
          Sessions akan kehilangan link project tapi tetap tersimpan di arsip.
        </p>
      )}
    </CenteredDialog>
  );
}