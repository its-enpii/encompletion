"use client";

import { useEffect, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CenteredDialog } from "@/components/ui/Modal";

/**
 * Per-user memory facts editor. The dialog lists persistent facts that
 * get injected into every chat's system prompt so the model remembers
 * user context (lokasi, role, bahasa, preferensi, dll) across sessions.
 *
 * v2 added the auto-extract toggle + badge. When ON, an idle-detection
 * worker reads the user's quiet sessions, runs a small LLM extractor
 * on the transcript, and stores candidate facts with source='auto'.
 * Manual edits don't flip source — see backend memory.js.
 *
 * Mirror of backend caps:
 *   - key matches /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/ — letters/digits/
 *     underscore/dash, 40 chars max, must start with letter.
 *   - value max 2000 chars.
 *   - 100 facts/user cap (server-enforced).
 */
type Fact = {
  id: number;
  user_id: number;
  key: string;
  value: string;
  source: "manual" | "auto";
  created_at: string;
  updated_at: string;
};

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_VALUE = 2000;

export function MemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm } = useUi();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Auto-memory toggle. Default true so existing users see the feature
  // immediately on first dialog open. Persisted on PUT /api/memory/settings.
  const [autoMemory, setAutoMemory] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (authLoading || !me) return;
    let cancelled = false;
    (async () => {
      try {
        const [rFacts, rSettings] = await Promise.all([
          authFetch("/api/memory/facts"),
          authFetch("/api/memory/settings"),
        ]);
        const jFacts = await rFacts.json().catch(() => ({}));
        const jSettings = await rSettings.json().catch(() => ({}));
        if (cancelled) return;
        setFacts(Array.isArray(jFacts.facts) ? jFacts.facts : []);
        if (typeof jSettings.auto_memory_enabled === "boolean") {
          setAutoMemory(jSettings.auto_memory_enabled);
        }
      } catch (e: any) {
        if (!cancelled) toast(e?.message || "Gagal memuat", "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.id]);

  async function toggleAutoMemory() {
    const next = !autoMemory;
    setAutoMemory(next); // optimistic
    setSavingToggle(true);
    try {
      const r = await authFetch("/api/memory/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_memory_enabled: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      toast(next ? "Auto-memory aktif" : "Auto-memory dimatikan", "success");
    } catch (e: any) {
      // Roll back on failure so the UI reflects truth.
      setAutoMemory(!next);
      toast(e?.message || "Gagal menyimpan", "error");
    } finally {
      setSavingToggle(false);
    }
  }

  function startEdit(f?: Fact) {
    if (f) {
      setEditingId(f.id);
      setDraftKey(f.key);
      setDraftValue(f.value);
    } else {
      setEditingId("new");
      setDraftKey("");
      setDraftValue("");
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftKey("");
    setDraftValue("");
  }

  async function save() {
    const key = draftKey.trim();
    const value = draftValue.trim();
    if (!key || !value) {
      toast("Key dan value wajib diisi", "error");
      return;
    }
    if (!KEY_RE.test(key)) {
      toast(
        "Key: huruf/angka/_, harus mulai dengan huruf, maks 40 karakter",
        "error"
      );
      return;
    }
    if (value.length > MAX_VALUE) {
      toast(`Value maks ${MAX_VALUE} karakter`, "error");
      return;
    }
    setSaving(true);
    try {
      const r = await authFetch(`/api/memory/facts/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const row = await r.json();
      setFacts((cur) => {
        const others = cur.filter((f) => f.id !== row.id);
        return [...others, row].sort((a, b) => a.key.localeCompare(b.key));
      });
      toast("Fakta disimpan", "success");
      cancelEdit();
    } catch (e: any) {
      toast(e?.message || "Gagal menyimpan", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(f: Fact) {
    const ok = await confirm({
      title: "Hapus fakta?",
      message: `Fakta "${f.key}" akan dihapus dari prompt.`,
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await authFetch(`/api/memory/facts/${f.id}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setFacts((cur) => cur.filter((x) => x.id !== f.id));
      if (editingId === f.id) cancelEdit();
      toast("Fakta dihapus", "success");
    } catch (e: any) {
      toast(e?.message || "Gagal menghapus", "error");
    }
  }

  const editingFact = editingId === "new" ? null : facts.find((f) => f.id === editingId);
  const dirty =
    draftKey.trim() !== (editingFact?.key ?? "") ||
    draftValue.trim() !== (editingFact?.value ?? "");

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Memory Facts"
      description={
        authLoading
          ? "Memuat…"
          : !me
            ? "Silakan login dulu."
            : "Fakta yang disimpan di sini otomatis disuntikkan ke system prompt setiap chat. Server menggunakan isi ini sebagai konteks user (mis. lokasi, role, bahasa)."
      }
      widthClass="max-w-2xl"
    >
      {authLoading || !me ? null : (
        <div className="space-y-3">
          {/* Auto-memory toggle — controls the worker's per-user opt-out.
              When OFF, no new facts are auto-extracted; existing facts
              (manual or auto) still inject into the prompt until deleted. */}
          <Card className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                Auto-memory
                <span
                  className={`inline-flex h-4 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide ${
                    autoMemory
                      ? "bg-[var(--saffron-200)]/20 text-[var(--saffron-700)]"
                      : "bg-[var(--paper-3)] text-[var(--ink-3)]"
                  }`}
                >
                  {autoMemory ? "ON" : "OFF"}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-[var(--ink-3)]">
                {autoMemory
                  ? "Worker baca chat yang idle, ekstrak fakta via LLM, simpan otomatis."
                  : "Worker di-skip. Fakta manual tetap dipakai; auto-extract off."}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoMemory}
              disabled={savingToggle}
              onClick={toggleAutoMemory}
              className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
                autoMemory
                  ? "border-[var(--saffron-300)] bg-[var(--saffron-200)]"
                  : "border-[var(--line)] bg-[var(--paper-3)]"
              } ${savingToggle ? "opacity-60" : ""}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  autoMemory ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </Card>

          <Card className="p-3">
            {loading ? (
              <div className="px-2 py-6 text-center text-sm text-[var(--ink-3)]">
                Memuat…
              </div>
            ) : (
              <ul className="divide-y divide-[var(--line)]">
                {facts.length === 0 && editingId !== "new" && (
                  <li className="px-2 py-4 text-center text-sm text-[var(--ink-3)]">
                    Belum ada fakta. Klik "Tambah fakta" di bawah.
                  </li>
                )}
                {facts.map((f) =>
                  editingId === f.id ? (
                    <li key={f.id} className="space-y-2 py-3">
                      <input
                        type="text"
                        value={draftKey}
                        disabled
                        className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] p-2 font-mono text-xs text-[var(--ink-2)] outline-none"
                        title="Key dikunci setelah fakta dibuat"
                      />
                      <textarea
                        value={draftValue}
                        onChange={(e) =>
                          setDraftValue(e.target.value.slice(0, MAX_VALUE))
                        }
                        rows={3}
                        className="block w-full resize-y rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] p-2 font-mono text-xs leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={save} disabled={saving || !dirty} variant="primary">
                          {saving ? "Menyimpan…" : "Simpan"}
                        </Button>
                        <Button onClick={cancelEdit} disabled={saving} variant="ghost">
                          Batal
                        </Button>
                        <span className="ml-auto text-xs text-[var(--ink-3)]">
                          {draftValue.length} / {MAX_VALUE}
                        </span>
                      </div>
                    </li>
                  ) : (
                    <li
                      key={f.id}
                      className="flex items-start gap-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-semibold text-[var(--magenta-300)]">
                            {f.key}
                          </span>
                          {f.source === "auto" && (
                            <span
                              className="inline-flex h-4 items-center rounded-full bg-[var(--saffron-200)]/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--saffron-700)]"
                              title="Dip auto-ekstrak dari chat. Bisa diedit/dihapus."
                            >
                              auto
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 break-words text-sm text-[var(--ink-2)]">
                          {f.value}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          onClick={() => startEdit(f)}
                          variant="ghost"
                          aria-label="Edit"
                        >
                          Edit
                        </Button>
                        <Button
                          onClick={() => remove(f)}
                          variant="ghost"
                          aria-label="Hapus"
                        >
                          Hapus
                        </Button>
                      </div>
                    </li>
                  )
                )}
                {editingId === "new" && (
                  <li className="space-y-2 py-3">
                    <input
                      type="text"
                      placeholder="key, mis. lokasi atau role"
                      value={draftKey}
                      onChange={(e) => setDraftKey(e.target.value)}
                      maxLength={40}
                      className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] p-2 font-mono text-xs text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                    />
                    <textarea
                      placeholder="value, mis. Jakarta"
                      value={draftValue}
                      onChange={(e) =>
                        setDraftValue(e.target.value.slice(0, MAX_VALUE))
                      }
                      rows={3}
                      className="block w-full resize-y rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] p-2 font-mono text-xs leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={save} disabled={saving || !dirty} variant="primary">
                        {saving ? "Menyimpan…" : "Simpan"}
                      </Button>
                      <Button onClick={cancelEdit} disabled={saving} variant="ghost">
                        Batal
                      </Button>
                      <span className="ml-auto text-xs text-[var(--ink-3)]">
                        {draftValue.length} / {MAX_VALUE}
                      </span>
                    </div>
                  </li>
                )}
              </ul>
            )}
            <div className="mt-3 border-t border-[var(--line)] pt-3">
              <Button
                onClick={() => startEdit()}
                disabled={loading || editingId !== null}
                variant="ghost"
              >
                + Tambah fakta
              </Button>
              <span className="ml-3 text-xs text-[var(--ink-3)]">
                {facts.length}/100 fakta
              </span>
            </div>
          </Card>

          <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-[12px] text-[var(--ink-2)]">
            <div className="font-semibold text-[var(--ink)]">Bagaimana记忆 bekerja</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>Setiap fakta disimpan per-user, tidak dibagikan ke user lain.</li>
              <li>Fakta otomatis dikirim sebagai bagian dari system prompt di setiap turn chat.</li>
              <li>Key tidak bisa diubah setelah dibuat — hapus + buat ulang untuk ganti key.</li>
              <li>
                Auto-memory (toggle di atas) panggil LLM kecil setiap session idle &gt; 5 menit.
                Fakta baru masuk dengan badge <code className="rounded bg-[var(--paper)] px-1 text-[10px]">auto</code>.
              </li>
            </ul>
          </div>
        </div>
      )}
    </CenteredDialog>
  );
}