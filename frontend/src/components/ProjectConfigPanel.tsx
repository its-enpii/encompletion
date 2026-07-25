"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth";
import { useUi } from "@/components/ui/UiProvider";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Card } from "@/components/ui/Card";

type Knowledge = {
  id: number;
  title: string;
  type: "text" | "file";
  content: string | null;
  file_name: string | null;
  file_path: string | null;
  created_at: string;
};

type ProjectFact = {
  id: number;
  project_id: number;
  key: string;
  value: string;
  source: "manual" | "auto";
  created_at: string;
  updated_at: string;
};

// Same regex the backend enforces (memory.js + project_memory.js).
// Mirror here so the user gets inline feedback before hitting the
// 400 round-trip. Letters/digits/underscore/dash, ≤ 40 chars,
// leading letter.
const FACT_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const MAX_FACT_VALUE_LEN = 2000;
const MAX_FACTS_PER_PROJECT = 100;

type Project = {
  id: number;
  name: string;
  description: string | null;
  instructions: string | null;
  color: string;
  archived_at: string | null;
  owner_username?: string;
};

type Props = {
  projectId: number;
};

export default function ProjectConfigPanel({ projectId }: Props) {
  const router = useRouter();
  const { confirm } = useUi();
  const [project, setProject] = useState<Project | null>(null);
  const [knowledge, setKnowledge] = useState<Knowledge[]>([]);
  const [loading, setLoading] = useState(true);
  // Mobile drawer state — the panel is hidden by default on mobile and
  // toggled via a "Settings" button mounted in the parent layout. On
  // desktop the panel is always visible (md:flex), so this state only
  // matters below the md breakpoint.
  const [mobileOpen, setMobileOpen] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [color, setColor] = useState("#A84781");
  // Per-project skill opt-outs (mirrors the global skill catalog
  // shadowed by project-specific bans). Persisted on saveMeta.
  const [allSkills, setAllSkills] = useState<{ name: string; description: string | null }[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<string[]>([]);
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaDirty, setMetaDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showKnowForm, setShowKnowForm] = useState(false);
  const [knTitle, setKnTitle] = useState("");
  const [knType, setKnType] = useState<"text" | "file">("text");
  const [knContent, setKnContent] = useState("");

  // Project memory facts (Phase 5) — key/value list auto-injected
  // into the system prompt for every chat in this project. Mirrors
  // the /api/memory UX shape but scoped to project.
  const [facts, setFacts] = useState<ProjectFact[]>([]);
  const [showFactForm, setShowFactForm] = useState(false);
  const [factKey, setFactKey] = useState("");
  const [factValue, setFactValue] = useState("");
  const [factSaving, setFactSaving] = useState(false);
  const [factError, setFactError] = useState<string | null>(null);
  // Staged file upload for knowledge rows. We POST via two steps:
  // (1) PUT /api/attachments to push the bytes to STORAGE_PATH, then
  // (2) POST /api/projects/:id/knowledge referencing the returned
  // file_path. We keep both values here so the second step knows
  // where the file landed and the metadata to record.
  const [knFile, setKnFile] = useState<{
    name: string;
    mime: string;
    size: number;
    dataBase64: string;
  } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [data, skillsData, factsData] = await Promise.all([
        authFetch(`/api/projects/${projectId}`).then((r) => r.json()),
        authFetch("/api/skills").then((r) => r.json()).catch(() => ({ skills: [] })),
        authFetch(`/api/projects/${projectId}/facts`).then((r) => r.json()).catch(() => ({ facts: [] })),
      ]);
      setProject(data.project);
      setKnowledge(data.knowledge || []);
      setName(data.project.name);
      setDescription(data.project.description || "");
      setInstructions(data.project.instructions || "");
      setColor(data.project.color);
      // Skill opt-outs come pre-parsed (route does the JSON.parse).
      // Cast through unknown — backend may return a missing or
      // non-array field on older rows and we want to fall back to [].
      const ds = data.project.disabled_skills;
      if (Array.isArray(ds)) setDisabledSkills(ds);
      else setDisabledSkills([]);
      // Skill catalog is loaded in parallel; keep only the fields
      // the toggle UI needs to render a label + description.
      const sk = Array.isArray(skillsData?.skills) ? skillsData.skills : [];
      setAllSkills(
        sk.map((s: any) => ({ name: s.name, description: s.description ?? null }))
      );
      // Project facts — fail closed (empty list) if the endpoint
      // returned non-200; UI shows "Belum ada fact" in that case.
      const fl = Array.isArray(factsData?.facts) ? factsData.facts : [];
      setFacts(fl);
      setMetaDirty(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [projectId]);

  // Listen to the "app:toggle-project-settings" event so the mobile FAB
  // (mounted separately in the project route) can open the bottom sheet
  // without prop-drilling the toggle through every layer above.
  useEffect(() => {
    function onToggle() { setMobileOpen((v) => !v); }
    window.addEventListener("app:toggle-project-settings", onToggle);
    return () => window.removeEventListener("app:toggle-project-settings", onToggle);
  }, []);

  async function saveMeta() {
    if (!project || !metaDirty) return;
    setSavingMeta(true);
    setSaveError(null);
    try {
      await authFetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          instructions: instructions || null,
          color,
          disabled_skills: disabledSkills,
        }),
      });
      await load();
    } catch (e: any) {
      setSaveError(e?.message || "save failed");
    } finally {
      setSavingMeta(false);
    }
  }

  async function archive() {
    if (!project) return;
    await authFetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: !project.archived_at }),
    });
    await load();
  }

  async function remove() {
    const ok = await confirm({
      title: "Hapus project",
      message: `Hapus project "${project?.name}"? Sessions akan kehilangan link project.`,
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    await authFetch(`/api/projects/${projectId}`, { method: "DELETE" });
    router.push("/projects");
  }

  async function addKnowledge() {
    if (!knTitle.trim()) return;
    if (knType === "text") {
      await authFetch(`/api/projects/${projectId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: knTitle, type: "text", content: knContent || null }),
      });
    } else {
      // File-type knowledge: ship the bytes to /api/attachments so the
      // backend stores them under STORAGE_PATH. Then reference that
      // path from the project_knowledge row. (Don't put the bytes in
      // the JSON body — keeps requests small and avoids base64-in-DB.)
      if (!knFile) {
        setKnTitle(""); setKnContent(""); setKnFile(null); setShowKnowForm(false);
        return;
      }
      const upRes = await authFetch("/api/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ name: knFile.name, mime_type: knFile.mime, dataBase64: knFile.dataBase64 }],
        }),
      });
      if (!upRes.ok) {
        const d = await upRes.json().catch(() => ({}));
        throw new Error(d.error || `upload failed: HTTP ${upRes.status}`);
      }
      const upData = await upRes.json();
      const uploaded = upData.files?.[0];
      if (!uploaded?.file_path) throw new Error("upload returned no file_path");
      await authFetch(`/api/projects/${projectId}/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: knTitle,
          type: "file",
          file_path: uploaded.file_path,
          file_name: knFile.name,
          mime_type: knFile.mime,
          size: knFile.size,
        }),
      });
    }
    setKnTitle(""); setKnContent(""); setKnFile(null); setShowKnowForm(false);
    load();
  }

  async function deleteKnowledge(kid: number) {
    const ok = await confirm({
      title: "Hapus knowledge",
      message: "Knowledge ini akan dihapus dari project.",
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    await authFetch(`/api/projects/${projectId}/knowledge/${kid}`, { method: "DELETE" });
    load();
  }

  // Project facts (Phase 5) — POST/PUT/DELETE /api/projects/:id/facts.
  // PUT semantics: same key upserts; we use PUT here for both create
  // and edit so the user never sees a different button. Validation
  // mirrors the backend (FACT_KEY_RE + max length + cap) so the user
  // gets fast inline feedback.
  async function saveFact() {
    const k = factKey.trim();
    const v = factValue.trim();
    setFactError(null);
    if (!FACT_KEY_RE.test(k)) {
      setFactError("key harus alphanumeric (huruf/angka/_/-), ≤ 40 char, mulai huruf");
      return;
    }
    if (v.length === 0) {
      setFactError("value wajib diisi");
      return;
    }
    if (v.length > MAX_FACT_VALUE_LEN) {
      setFactError(`value max ${MAX_FACT_VALUE_LEN} char`);
      return;
    }
    if (facts.length >= MAX_FACTS_PER_PROJECT && !facts.some((f) => f.key === k)) {
      setFactError(`max ${MAX_FACTS_PER_PROJECT} facts per project`);
      return;
    }
    setFactSaving(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/facts/${encodeURIComponent(k)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: v }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setFactKey(""); setFactValue(""); setShowFactForm(false);
      await load();
    } catch (e: any) {
      setFactError(e?.message || "save failed");
    } finally {
      setFactSaving(false);
    }
  }

  async function deleteFact(fid: number) {
    const ok = await confirm({
      title: "Hapus fact",
      message: "Fact ini akan dihapus dari project.",
      confirmLabel: "Hapus",
      destructive: true,
    });
    if (!ok) return;
    await authFetch(`/api/projects/${projectId}/facts/${fid}`, { method: "DELETE" });
    load();
  }

  if (loading || !project) {
    return (
      <aside className="hidden w-[26rem] shrink-0 border-l border-[var(--line)] bg-[var(--paper-2)] p-6 text-sm text-[var(--ink-3)] md:block">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--magenta)]" />
          Memuat project…
        </div>
      </aside>
    );
  }

  return (
    <>
      {/* Mobile backdrop: blocks interaction with the chat when the settings
          sheet is open. Clicking it closes the sheet. The backdrop only
          shows below md; on desktop the panel is a sticky right rail. */}
      {mobileOpen && (
        <div
          className="anim-fade-in fixed inset-0 z-30 bg-[#1A1410]/40 backdrop-blur-sm md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`dark-scroll fixed inset-x-0 bottom-0 z-40 flex max-h-[85vh] shrink-0 flex-col overflow-hidden rounded-t-2xl border-t border-[var(--line)] bg-gradient-to-b from-[var(--paper-2)] to-[var(--paper)] shadow-[0_-8px_32px_-12px_rgba(26,20,16,0.18)] transition-transform duration-300 ease-out md:static md:inset-auto md:max-h-none md:w-[26rem] md:rounded-none md:border-l md:border-t-0 md:shadow-none ${
          // Mobile: slide up from the bottom when open, hide when closed.
          // Desktop: always visible (md:translate-y-0).
          mobileOpen ? "translate-y-0" : "translate-y-full md:translate-y-0"
        }`}
      >
        {/* Mobile drag handle — purely visual on md+; gives the user a
            visual affordance to grab and dismiss. */}
        <div className="flex shrink-0 justify-center pt-2 md:hidden">
          <span className="h-1 w-10 rounded-full bg-[var(--line-strong)]" />
        </div>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper-3)]/80 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full ring-2 ring-[var(--paper-3)] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06),var(--shadow-1)]"
            style={{ background: color }}
          />
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setMetaDirty(true); }}
            onBlur={saveMeta}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold tracking-tight text-[var(--ink)] outline-none transition-colors hover:text-[var(--magenta-700)] focus:text-[var(--magenta-700)]"
            placeholder="Project name…"
          />
          <span className="rounded-full bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-3)] ring-1 ring-inset ring-[var(--line)]">
            #{projectId}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Mobile-only close — keeps the bottom-sheet metaphor intact.
              Hidden on md+ where the panel is a permanent right rail. */}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close settings"
            className="grid h-7 w-7 place-items-center rounded-[var(--r-sm)] text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)] md:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
          <Link
            href="/projects"
            className="inline-flex items-center gap-1 rounded-[var(--r-sm)] px-2 py-1 text-xs text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            All
          </Link>
        </div>
      </div>

      <div className="dark-scroll flex-1 overflow-y-auto p-3 space-y-3">
        {/* Meta */}
        <Section title="Meta" subtitle="auto-saved on blur" icon="settings">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-xs text-[var(--ink-3)]">Color</label>
              <div className="relative">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => { setColor(e.target.value); setMetaDirty(true); }}
                  onBlur={saveMeta}
                  className="h-7 w-10 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0.5"
                />
              </div>
              {project.owner_username && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--ink-3)]">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                  <span>@{project.owner_username}</span>
                </span>
              )}
            </div>

            <StyledTextarea
              label="Description"
              helper="Ringkasan singkat yang muncul di sidebar & projects list (opsional)"
              value={description}
              onChange={(e) => { setDescription(e.target.value); setMetaDirty(true); }}
              onBlur={saveMeta}
              placeholder="e.g. Tools & scripts untuk operasional harian…"
              rows={2}
              maxLength={280}
            />
            <SaveStatus saving={savingMeta} dirty={metaDirty} error={saveError} />
          </div>
        </Section>

        {/* Instructions */}
        <Section
          title="Instructions"
          subtitle="injected to system prompt"
          icon="code"
          accent="saffron"
          headerExtras={<CharPill value={instructions.length} warn={instructions.length > 4000} />}
        >
          <StyledTextarea
            value={instructions}
            onChange={(e) => { setInstructions(e.target.value); setMetaDirty(true); }}
            onBlur={saveMeta}
            placeholder="Ketik instruksi untuk project ini. Akan di-inject ke system prompt saat session dimulai.&#10;&#10;Contoh: fokus pada PHP/Laravel, selalu jawab dalam Bahasa Indonesia…"
            rows={7}
            mono
            maxLength={6000}
            showClear
          />
        </Section>

        {/* Knowledge */}
        <Section
          title="Knowledge"
          subtitle={`${knowledge.length} included in prompt`}
          icon="book"
          action={
            <Button
              variant={showKnowForm ? "ghost" : "primary"}
              size="sm"
              onClick={() => setShowKnowForm((v) => !v)}
            >
              {showKnowForm ? "Cancel" : (
                <>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add
                </>
              )}
            </Button>
          }
        >
          {showKnowForm && (
            <Card className="mb-3 overflow-hidden">
              <div className="border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
                  Tambah knowledge
                </div>
              </div>
              <div className="space-y-3 px-4 py-3">
                <div>
                  <label className="label mb-1.5 block">Judul</label>
                  <input
                    type="text"
                    value={knTitle}
                    onChange={(e) => setKnTitle(e.target.value)}
                    placeholder="e.g. Database schema, API contract…"
                    className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                  />
                </div>
                <div>
                  <label className="label mb-1.5 block">Tipe</label>
                  <div className="flex gap-0.5 rounded-[var(--r-md)] bg-[var(--paper-2)] p-0.5 ring-1 ring-inset ring-[var(--line)]">
                    {(["text", "file"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setKnType(t)}
                        className={`flex-1 rounded-[6px] px-2 py-1 text-xs font-medium capitalize transition-all ${
                          knType === t
                            ? "bg-[var(--paper-3)] text-[var(--ink)] shadow-[var(--shadow-1)]"
                            : "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                {knType === "text" && (
                  <div>
                    <label className="label mb-1.5 block">Konten</label>
                    <textarea
                      value={knContent}
                      onChange={(e) => setKnContent(e.target.value)}
                      placeholder="Tulis isi knowledge di sini…"
                      rows={4}
                      className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                    />
                  </div>
                )}
                {knType === "file" && (
                  <div>
                    <label className="label mb-1.5 block">File</label>
                    <label className="flex cursor-pointer items-center gap-2 rounded-[var(--r-md)] border border-dashed border-[var(--line)] bg-[var(--paper-3)] px-3 py-2.5 text-xs text-[var(--ink-3)] transition-colors hover:border-[var(--magenta)]/40 hover:text-[var(--ink-2)]">
                      <input
                        type="file"
                        hidden
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          e.currentTarget.value = "";
                          if (!f) return;
                          const buf = await f.arrayBuffer();
                          setKnFile({
                            name: f.name,
                            mime: f.type || "application/octet-stream",
                            size: f.size,
                            dataBase64: btoa(String.fromCharCode(...new Uint8Array(buf))),
                          });
                        }}
                      />
                      {knFile ? (
                        <span className="flex items-center gap-2 truncate">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[var(--ink-2)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="truncate font-mono text-[var(--ink-2)]">{knFile.name}</span>
                          <span className="shrink-0 text-[var(--ink-3)]">{(knFile.size / 1024).toFixed(1)} KB</span>
                        </span>
                      ) : (
                        <span>Pilih file…</span>
                      )}
                    </label>
                    <p className="mt-1.5 text-[11px] text-[var(--ink-3)]">
                      Isi file akan di-include ke prompt saat chat di project ini. Max ~512KB total.
                    </p>
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="ghost" size="sm" onClick={() => setShowKnowForm(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={addKnowledge} disabled={!knTitle.trim() || (knType === "file" && !knFile)}>
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Save
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {knowledge.length === 0 ? (
            <div className="rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] bg-[var(--paper-2)]/60 px-3 py-6 text-center">
              <div className="mx-auto grid h-8 w-8 place-items-center rounded-full bg-[var(--saffron-50)] text-[var(--saffron-500)]">
                <BookIcon className="h-4 w-4" />
              </div>
              <p className="mt-2 text-xs font-medium text-[var(--ink-2)]">Belum ada knowledge</p>
              <p className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                Klik "Add" untuk menambahkan konteks project.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {knowledge.map((k) => (
                <li
                  key={k.id}
                  className="group/kn group flex items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] p-2.5 transition-all hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-1)]"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--saffron-50)] text-[var(--saffron-500)]" aria-hidden>
                    {k.type === "text"
                      ? <BookIcon className="h-3.5 w-3.5" />
                      : <FileIcon className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--ink)]">{k.title}</span>
                      <Pill tone="neutral">{k.type}</Pill>
                    </div>
                    {k.content && (
                      <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded border-l-2 border-[var(--saffron)] bg-[var(--paper-2)] px-2 py-1.5 font-mono text-[11px] text-[var(--ink-2)]">
                        {k.content}
                      </pre>
                    )}
                    {k.type === "file" && k.file_name && (
                      <div className="mt-1 truncate text-xs text-[var(--ink-3)]">{k.file_name}</div>
                    )}
                  </div>
                  <button
                    onClick={() => deleteKnowledge(k.id)}
                    className="shrink-0 rounded-[var(--r-sm)] p-1 text-[var(--ink-3)] opacity-0 transition-all hover:bg-[var(--danger-50)] hover:text-[var(--danger)] group-hover/kn:opacity-100 focus-visible:opacity-100"
                    aria-label="Delete"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Project facts (Phase 5) — key/value list auto-injected into
            the system prompt for every chat in this project. Same
            shape as /api/memory but scoped to project_id. Cap badge
            mirrors the memory page. Cap is enforced server-side;
            this UI is just a heads-up. */}
        <Section
          title="Project facts"
          subtitle={
            facts.length >= MAX_FACTS_PER_PROJECT
              ? `cap reached (${MAX_FACTS_PER_PROJECT})`
              : `${facts.length} / ${MAX_FACTS_PER_PROJECT} injected to system prompt`
          }
          icon="cpu"
          accent="saffron"
          action={
            <Button
              variant={showFactForm ? "ghost" : "primary"}
              size="sm"
              onClick={() => { setShowFactForm((v) => !v); setFactError(null); }}
              disabled={facts.length >= MAX_FACTS_PER_PROJECT && !showFactForm}
            >
              {showFactForm ? "Cancel" : (
                <>
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  Add
                </>
              )}
            </Button>
          }
        >
          {showFactForm && (
            <Card className="mb-3 overflow-hidden">
              <div className="border-b border-[var(--line)] bg-[var(--paper-2)] px-4 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-3)]">
                  Tambah fact
                </div>
              </div>
              <div className="space-y-3 px-4 py-3">
                <div>
                  <label className="label mb-1.5 block">Key</label>
                  <input
                    type="text"
                    value={factKey}
                    onChange={(e) => setFactKey(e.target.value)}
                    placeholder="e.g. stack, db, owner"
                    maxLength={40}
                    className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 font-mono text-xs text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                  />
                  <p className="mt-1 text-[11px] text-[var(--ink-3)]">
                    Huruf/angka/underscore/dash, ≤ 40 char, mulai huruf.
                  </p>
                </div>
                <div>
                  <label className="label mb-1.5 block">Value</label>
                  <textarea
                    value={factValue}
                    onChange={(e) => setFactValue(e.target.value)}
                    placeholder="e.g. Laravel 11, postgres, alice@acme.com"
                    rows={3}
                    maxLength={MAX_FACT_VALUE_LEN}
                    className="block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15"
                  />
                  <div className="mt-1 flex justify-end">
                    <CharPill value={factValue.length} max={MAX_FACT_VALUE_LEN} warn={factValue.length > MAX_FACT_VALUE_LEN} />
                  </div>
                </div>
                {factError && (
                  <div className="text-xs text-[var(--danger)]">{factError}</div>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="ghost" size="sm" onClick={() => { setShowFactForm(false); setFactError(null); }}>
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm" onClick={saveFact} disabled={factSaving || !factKey.trim() || !factValue.trim()}>
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Save
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {facts.length === 0 ? (
            <div className="rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] bg-[var(--paper-2)]/60 px-3 py-6 text-center">
              <p className="text-xs font-medium text-[var(--ink-2)]">Belum ada fact</p>
              <p className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                Klik "Add" untuk menambahkan key/value yang akan di-inject ke system prompt.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {facts.map((f) => (
                <li
                  key={f.id}
                  className="group/fact group flex items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] p-2.5 transition-all hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-1)]"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-sm)] bg-[var(--saffron-50)] text-[var(--saffron-500)]" aria-hidden>
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink-2)]">{f.key}</code>
                      {f.source === "auto" && <Pill tone="neutral">[auto]</Pill>}
                    </div>
                    <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--ink-2)]">{f.value}</div>
                  </div>
                  <button
                    onClick={() => deleteFact(f.id)}
                    className="shrink-0 rounded-[var(--r-sm)] p-1 text-[var(--ink-3)] opacity-0 transition-all hover:bg-[var(--danger-50)] hover:text-[var(--danger)] group-hover/fact:opacity-100 focus-visible:opacity-100"
                    aria-label="Delete"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Skills — per-project opt-out. The catalog is global but
            each project can shadow a name here so the LLM never sees
            it (Skill.list and Skill.read return the filtered set
            for any chat bound to this project). Edit toggles mark
            the project dirty so saveMeta persists everything in
            one PATCH. */}
        <Section
          title="Skills"
          subtitle={
            disabledSkills.length
              ? `${disabledSkills.length} skill disembunyikan dari chat project ini`
              : "Semua skill terlihat di chat project ini"
          }
          icon="cpu"
        >
          {allSkills.length === 0 ? (
            <div className="rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] bg-[var(--paper-2)]/60 px-3 py-6 text-center">
              <p className="text-xs font-medium text-[var(--ink-2)]">Belum ada skill di catalog</p>
              <p className="mt-0.5 text-[11px] text-[var(--ink-3)]">Buka Skills di composer untuk menambah.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {allSkills.map((s) => {
                const off = disabledSkills.includes(s.name);
                return (
                  <li
                    key={s.name}
                    className="flex items-start gap-3 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="rounded bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink-2)]">{s.name}</code>
                        <Pill tone={off ? "danger" : "success"}>
                          {off ? "disembunyikan" : "aktif"}
                        </Pill>
                      </div>
                      {s.description && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-[var(--ink-3)]">{s.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        // Mark dirty so saveMeta persists the toggle.
                        setMetaDirty(true);
                        setDisabledSkills((cur) =>
                          off ? cur.filter((n) => n !== s.name) : [...cur, s.name]
                        );
                      }}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                        off ? "bg-[var(--danger)]/60" : "bg-[var(--success)]/70"
                      }`}
                      aria-pressed={!off}
                      title={off ? "Enable untuk project ini" : "Disable untuk project ini"}
                    >
                      <span
                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
                          off ? "left-0.5" : "left-[18px]"
                        }`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* Actions */}
        <Section title="Actions" icon="zap">
          <div className="flex flex-col gap-1.5">
            <Button variant="ghost" onClick={archive} className="justify-start">
              {project.archived_at ? (
                <>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="13 17 18 12 13 7" />
                    <polyline points="6 17 11 12 6 7" />
                  </svg>
                  Unarchive project
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="21 8 21 21 3 21 3 8" />
                    <rect x="1" y="3" width="22" height="5" />
                    <line x1="10" y1="12" x2="14" y2="12" />
                  </svg>
                  Archive project
                </>
              )}
            </Button>
            <Button variant="ghost" onClick={remove} className="justify-start text-[var(--danger)] hover:bg-[var(--danger-50)]">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
              </svg>
              Delete project
            </Button>
          </div>
        </Section>
      </div>
    </aside>
    </>
  );
}

/* ================================================================
   Reusable polished textarea with helper text, char count,
   clear button, and optional monospace font.
   ================================================================ */
function StyledTextarea({
  label,
  helper,
  maxLength,
  mono,
  showClear,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: React.ReactNode;
  helper?: React.ReactNode;
  maxLength?: number;
  mono?: boolean;
  showClear?: boolean;
}) {
  const value: string = String((rest as any).value ?? "");
  const onChange = rest.onChange;
  const onClear = () => {
    if (onChange) {
      const ev = { target: { value: "" } } as any;
      onChange(ev as any);
    }
  };
  const overLimit = maxLength != null && value.length > maxLength;

  return (
    <div>
      {(label || helper || maxLength != null) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          {label && <label className="label">{label}</label>}
          {maxLength != null && (
            <CharPill value={value.length} max={maxLength} warn={overLimit} />
          )}
        </div>
      )}
      {helper && (
        <p className="mb-1.5 text-[11px] leading-relaxed text-[var(--ink-3)]">{helper}</p>
      )}
      <div className="group/ta relative">
        <textarea
          {...rest}
          className={`block w-full rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--paper-3)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-3)] shadow-[var(--shadow-1)] transition-colors hover:border-[var(--line-strong)] focus:border-[var(--magenta)] focus:outline-none focus:ring-2 focus:ring-[var(--magenta)]/15 ${
            mono ? "font-mono text-[12px]" : ""
          }`}
        />
        {showClear && value.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded text-[var(--ink-3)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink-2)] focus-visible:opacity-100"
            aria-label="Clear"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function CharPill({ value, max, warn }: { value: number; max?: number; warn?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset transition-colors ${
        warn
          ? "bg-[var(--danger-50)] text-[var(--danger)] ring-[var(--danger)]/30"
          : "bg-[var(--paper-2)] text-[var(--ink-3)] ring-[var(--line)]"
      }`}
      aria-label={max != null ? `${value} of ${max} characters` : `${value} characters`}
    >
      <span className="font-semibold tabular-nums">{value.toLocaleString()}</span>
      {max != null && (
        <>
          <span className="opacity-50">/</span>
          <span className="tabular-nums">{max.toLocaleString()}</span>
        </>
      )}
    </span>
  );
}

function SaveStatus({ saving, dirty, error }: { saving: boolean; dirty: boolean; error: string | null }) {
  let icon: React.ReactNode;
  let label: string;
  let color: string;
  if (saving) {
    icon = <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
    label = "saving…";
    color = "text-[var(--saffron-500)]";
  } else if (error) {
    icon = <span>!</span>;
    label = error;
    color = "text-[var(--danger)]";
  } else if (dirty) {
    icon = <span>●</span>;
    label = "unsaved";
    color = "text-[var(--warning)]";
  } else {
    icon = <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>;
    label = "saved";
    color = "text-[var(--success)]";
  }
  return (
    <div className={`inline-flex items-center gap-1.5 text-xs ${color}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function Section({
  title,
  subtitle,
  icon,
  action,
  accent = "default",
  headerExtras,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: "settings" | "code" | "book" | "zap" | "cpu";
  action?: React.ReactNode;
  accent?: "default" | "saffron";
  headerExtras?: React.ReactNode;
  children: React.ReactNode;
}) {
  const accentIconCls =
    accent === "saffron"
      ? "bg-[var(--saffron-50)] text-[var(--saffron-500)]"
      : "bg-[var(--magenta-50)] text-[var(--magenta-700)]";

  return (
    <Card className="overflow-hidden">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--paper-3)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon && (
            <span className={`grid h-6 w-6 place-items-center rounded-[var(--r-sm)] ${accentIconCls}`}>
              <SectionIcon name={icon} className="h-3.5 w-3.5" />
            </span>
          )}
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-[var(--ink)]">{title}</span>
            {subtitle && <span className="text-[11px] text-[var(--ink-3)]">{subtitle}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerExtras}
          {action}
        </div>
      </header>
      <div className="bg-[var(--paper-2)] p-3">{children}</div>
    </Card>
  );
}

function SectionIcon({ name, ...props }: { name: "settings" | "code" | "book" | "zap" | "cpu" } & React.SVGProps<SVGSVGElement>) {
  if (name === "settings") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
  if (name === "code") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>;
  if (name === "book") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>;
  if (name === "cpu") return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" /><line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" /><line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" /><line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>;
}

function BookIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>;
}
function FileIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>;
}