"use client";

import { useState } from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

export type User = {
  id: number;
  username: string;
  display_name: string | null;
  role: "admin" | "member";
  disabled: boolean;
  created_at: string;
  updated_at: string | null;
  last_login_at: string | null;
};

type Kind =
  | { kind: "create" }
  | { kind: "edit"; user: User; isSelf: boolean }
  | { kind: "reset"; user: User };

export function UserDialog({
  value,
  onClose,
  onSubmit,
}: {
  value: Kind | null;
  onClose: () => void;
  onSubmit: (payload: unknown) => Promise<void>;
}) {
  if (!value) return null;

  return (
    <CenteredDialog
      open
      onClose={onClose}
      title={
        value.kind === "create"
          ? "Tambah user"
          : value.kind === "edit"
            ? `Edit: ${value.user.username}`
            : `Reset password: ${value.user.username}`
      }
      widthClass="max-w-md"
    >
      {value.kind === "create" && (
        <CreateForm onCancel={onClose} onSubmit={onSubmit} />
      )}
      {value.kind === "edit" && (
        <EditForm user={value.user} isSelf={value.isSelf} onCancel={onClose} onSubmit={onSubmit} />
      )}
      {value.kind === "reset" && (
        <ResetForm user={value.user} onCancel={onClose} onSubmit={onSubmit} />
      )}
    </CenteredDialog>
  );
}

function CreateForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: unknown) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ username, display_name: displayName, password, role });
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="space-y-3"
    >
      <TextField
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
      />
      <TextField
        label="Display name (opsional)"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <TextField
        label="Password (min 6)"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div>
        <label className="label mb-1.5 block">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "admin" | "member")}
          className="input"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Batal
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={busy || !username.trim() || password.length < 6}
        >
          {busy ? "Membuat…" : "Buat"}
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  user,
  isSelf,
  onCancel,
  onSubmit,
}: {
  user: User;
  isSelf: boolean;
  onCancel: () => void;
  onSubmit: (payload: unknown) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(user.display_name || "");
  const [role, setRole] = useState<"admin" | "member">(user.role);
  const [disabled, setDisabled] = useState(user.disabled);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit({ role, display_name: displayName, disabled });
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <TextField
        label="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <div>
        <label className="label mb-1.5 block">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "admin" | "member")}
          disabled={isSelf}
          className="input"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        {isSelf && <p className="mt-1 text-xs text-[var(--ink-3)]">Tidak bisa ubah role sendiri.</p>}
      </div>
      <label className="flex items-center gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={disabled}
          onChange={(e) => setDisabled(e.target.checked)}
          disabled={isSelf}
          className="h-4 w-4 rounded border-[var(--line-strong)] bg-[var(--paper-3)] accent-[var(--magenta)]"
        />
        <span className="text-[var(--ink-2)]">Disabled (tidak bisa login)</span>
      </label>
      {isSelf && <p className="text-xs text-[var(--ink-3)]">Tidak bisa disable akun sendiri.</p>}
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Batal
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan"}
        </Button>
      </div>
    </form>
  );
}

function ResetForm({
  user,
  onCancel,
  onSubmit,
}: {
  user: User;
  onCancel: () => void;
  onSubmit: (payload: unknown) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (password.length < 6) return setErr("Password minimal 6 karakter");
    if (password !== confirm) return setErr("Password tidak sama");
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(password);
    } catch (e: any) {
      setErr(e?.message || "failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3">
      <TextField
        label="Password baru (min 6)"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <TextField
        label="Konfirmasi"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {err && (
        <div className="rounded-[var(--r-md)] border border-[var(--danger)]/40 bg-[var(--danger-50)] px-3 py-2 text-sm text-[var(--danger)]">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Batal
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : "Reset"}
        </Button>
      </div>
    </form>
  );
}