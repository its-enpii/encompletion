# Roadmap: Encompletion → Agentic AI Assistant

Arah product: dari chat multi-user + tool loop, ke assistant yang **berpikir dan beraksi** (baca/buat dokumen, planning, aksi terstruktur) — bukan pure Q&A, bukan multi-tenant embed SaaS.

Status baseline (Juli 2026): tool loop, Read/Write/Edit/Glob/Grep/Web*, skills, RAG, memory, artifacts, attachment extract (PDF/DOCX/XLSX), multi-user JWT.

**Fase 1: DONE** — embed/tenant, API keys publik, `/v1` dihapus.

---

## Prinsip

1. **Hapus dulu, tambah belakangan** — kurangi surface area sebelum fitur baru.
2. **Typed tools > free shell** — Bash tetap off di platform; aksi lewat tool bernama.
3. **Skill + artifact** untuk planning/PRD — jangan bikin app planning terpisah.
4. **Frontend rebuild terakhir** — setelah backend surface mengecil.

---

## Fase 1 — Hapus API keys + tenant/embed ✅ DONE

**Tujuan:** single-product assistant multi-user (JWT). Tidak ada public API key, tidak ada embed widget multi-tenant.

Hapus / cabut:

| Area | Item |
|---|---|
| Routes | `/api/api-keys`, `/api/v1`, `/api/embed`, `/api/admin/embed` |
| Middleware | `api-key`, `embed-token`, `tenant-api-key` |
| Modules | `embed-*.js`, `tool-executor.js` (Kategori B), embed static `/embed` |
| DB (logical) | `api_keys`, `tenants`, `tenant_api_keys`, `tenant_capability_profile`, `tools`, `tool_executions`, `embed_tokens`; kolom `owner_type`/`owner_id`/`external_user_id` di projects/sessions (kembali ke user-owned) |
| Frontend | `ApiKeysDialog`, `EmbedAdminDialog`, `lib/api-keys.ts`, referensi admin menu |
| E2E / tests | embed isolation, api-key, v1, cross-tenant |
| Docs / env | sebutan API key publik, tenant, embed |

**Sisa auth:** JWT cookie saja. Provider key tetap 1 global di env (`LLM_API_KEY` / `OPENAI_API_KEY`).

**Done when:** server boot tanpa mount embed/v1/api-keys; admin UI tanpa menu keys/embed; test suite hijau tanpa file embed/tenant.

---

## Fase 2 — Generate dokumen (PDF / Excel / PPTX) server-side ✅ DONE

**Sudah ada:** baca lampiran (extractors), artifact text/HTML/MD/CSV, export client-side (jsPDF/xlsx).

**Ditambah:**

- Tool model: `CreateDocument` (format `xlsx` | `pdf` | `pptx`) → binary di `storage/attachments/docs/{sessionId}/`
- Artifact type `file` + kolom `file_path` / `mime_type` / `file_size`
- Download: `GET /api/artifacts/:id/download`
- UI: card + viewer “Unduh file”
- **Baca PPTX:** extractors pull `a:t` dari slide XML (teks per slide + notes). Legacy `.ppt` tidak didukung.
- **Buat PPTX:** `buildPptx` via pptxgenjs (`slides: [{ title, bullets, notes }]`)

**Done when:** user minta “buat file excel/pdf/ppt rekap X” → file terunduh; lampiran `.pptx` masuk konteks LLM sebagai teks slide.

---

## Fase 3 — Planning / PRD / diagram ✅ DONE

- Skill disk: `backend/skills/planning` + `prd` (di-seed ke `ENLLM_SKILLS_DIR` on boot)
- Mermaid: `MermaidBlock` + `CodeBlock` (chat) + markdown artifact via `MarkdownView`
- System prompt mengarahkan Skill_read planning/prd

**Done when:** “buat PRD fitur Y + diagram alur” → MD + mermaid ter-render + bisa di-iterate.

---

## Fase 4 — Rebuild frontend flow ✅ DONE

- Chat-first: `/` → `/new`; EmptyHero = “Kirim → AI kerja → hasil”
- Suggestion cards isi composer (tanya, dokumen, plan/PRD, Excel/PDF)
- Composer hint + footer mirror capability (bukan coding agent)
- Admin tetap di UserMenu dialogs (tidak di flow chat)
- **P0 fixes:** artifact panel toggle + auto-open, layout right-rail `md:flex-row`, CodeBlock hooks order, React preview `htmlShell` di dialog, message_id keying, regenerate clears artifacts
- **P1:** TYPE_META `file`, card label, project chat URL, mobile model select, Effort UI dihapus (dead), copy login/system prompt/models, ToolBlock CreateDocument/Skill

**Done when:** user baru paham “kirim → AI kerja → hasil” tanpa buka admin; panel artifact benar-benar dipakai.

---

## Estimasi

| Scope | Waktu (1 orang + Claude Code) |
|---|---|
| Fase 1 saja | 3–5 hari |
| MVP (Fase 1–3, UI minor) | ~2 minggu |
| Full (Fase 1–4) | ~4–7 minggu |

---

## Di luar scope (sengaja)

- Multi-agent / sub-agent orchestration
- Billing / sharing (ex-Phase 6)
- Computer use / browser automation
- Per-user provider API keys
- Bash default-on di platform

---

## Urutan eksekusi

```
Fase 1 (hapus tenant/keys)
  → Fase 2 (doc create tools)
  → Fase 3 (planning skill + mermaid)
  → Fase 4 (frontend flow)
```

Update status di checklist README saat tiap fase selesai.
