"use client";

import { useEffect, useState } from "react";
import { authFetch, useAuth } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CenteredDialog } from "@/components/ui/Modal";

/**
 * Per-user system prompt editor — surfaced as a centered modal.
 * Replaces the persona default llm-runner.js normally injects as
 * `messages[0]`. Empty string = use default. Cap mirrors backend (64KB).
 */
const DEFAULT_PROMPT = `You are a helpful chat assistant in a web conversation UI
(like Claude, ChatGPT, or Gemini). Answer clearly. Prefer natural prose.
You are not a coding agent and you cannot run shell commands.

When the user wants a sizable deliverable (HTML, React, SVG, markdown,
config, script, plan, PRD), publish it with EmitArtifact. Skip for short
inline examples. Do not also paste the full body as a fenced block.

For real Excel/PDF/PowerPoint downloads use CreateDocument (xlsx|pdf|pptx).
For plans/roadmaps use Skill_read "planning"; for PRDs use "prd".
Put diagrams in fenced mermaid blocks.

Workspace tools (Read/Write/Edit/Glob/Grep) are only for drafting
multi-file artifacts before EmitArtifact — not a project repo to run.

WebSearch for open-ended / current research; WebFetch for specific URLs.
Cite sources. Skip if the user says not to look it up.

When you finish a turn, wait for the user — do not ask for the next task.`;

export function SystemPromptDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user: me, loading: authLoading } = useAuth();
  const { toast, confirm } = useUi();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (authLoading || !me) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch("/api/auth/system-prompt");
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        const v = typeof j.system_prompt === "string" ? j.system_prompt : "";
        setSaved(v);
        setDraft(v);
      } catch (e: any) {
        if (!cancelled) toast(e?.message || "Gagal memuat", "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, authLoading, me?.id]);

  async function save() {
    const trimmed = draft.trim();
    setSaving(true);
    try {
      const r = await authFetch("/api/auth/system-prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: trimmed.length > 0 ? trimmed : null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      const v = typeof j.system_prompt === "string" ? j.system_prompt : "";
      setSaved(v);
      setDraft(v);
      toast("System prompt disimpan", "success");
    } catch (e: any) {
      toast(e?.message || "Gagal menyimpan", "error");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    const ok = await confirm({
      title: "Reset ke default",
      message: "Prompt yang kamu simpan akan dihapus. Chat berikutnya pakai bawaan (chat assistant).",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await authFetch("/api/auth/system-prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = await r.json();
      const v = typeof j.system_prompt === "string" ? j.system_prompt : "";
      setSaved(v);
      setDraft(v);
      toast("Default dikembalikan", "success");
    } catch (e: any) {
      toast(e?.message || "Gagal reset", "error");
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft.trim() !== (saved ?? "").trim();
  const charCount = draft.length;

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="System Prompt"
      description={
        authLoading
          ? "Memuat…"
          : !me
            ? "Silakan login dulu."
            : "Ganti persona default yang dipakai tiap turn. Kosongkan untuk pakai bawaan. Hanya memengaruhi messages[0] — project knowledge, session override, dan RAG context tetap berlaku normal."
      }
      widthClass="max-w-2xl"
    >
      {authLoading || !me ? null : (
        <div className="space-y-3">
          <Card className="p-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={12}
              disabled={loading || saving}
              placeholder="Kosongkan untuk pakai bawaan."
              maxLength={65536}
              className="block w-full resize-y rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper)] p-3 font-mono text-xs leading-relaxed text-[var(--ink)] outline-none focus:border-[var(--magenta-300)]"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={saving || loading || !dirty} variant="primary">
                {saving ? "Menyimpan…" : "Simpan"}
              </Button>
              <Button onClick={resetToDefault} disabled={saving || loading} variant="ghost">
                Reset ke default
              </Button>
              <span className="ml-auto text-xs text-[var(--ink-3)]">
                {saved && saved.length > 0
                  ? `Tersimpan: ${saved.length} karakter`
                  : "Belum disimpan — pakai bawaan"}
                {" · "}
                <span className={charCount > 60000 ? "text-[var(--saffron-700)]" : ""}>
                  {charCount.toLocaleString("id-ID")} / 65.536
                </span>
              </span>
            </div>
          </Card>

          <details className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-2)] px-4 py-3 text-sm text-[var(--ink-2)]">
            <summary className="cursor-pointer text-[var(--ink)]">Default bawaan (untuk referensi)</summary>
            <pre className="mt-3 overflow-x-auto whitespace-pre rounded-[var(--paper-3)] bg-[var(--paper)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink-2)]">
              {DEFAULT_PROMPT}
            </pre>
          </details>
        </div>
      )}
    </CenteredDialog>
  );
}