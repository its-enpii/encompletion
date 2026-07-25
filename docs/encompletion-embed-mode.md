# Encompletion — Embed Mode Architecture Guide

> Dokumen ini adalah panduan pengembangan untuk menambahkan **mode embed
> (in-app assistant)** di atas Encompletion yang sudah ada — platform
> chat AI multi-user (seperti Claude.ai/ChatGPT self-hosted). Encompletion
> tetap menjadi produk utama; mode embed adalah kapabilitas tambahan agar
> engine yang sama bisa ditanam sebagai chatbot CS + task-assistant di
> aplikasi SaaS klien (LaundryAja, EnStore, SIDBM, dsb).

---

## 1. Reframing: Dua Model Penggunaan

Encompletion punya dua konteks pemakaian yang berbeda, hidup berdampingan
di satu codebase:

| | **Platform Mode** (existing) | **Embed Mode** (baru) |
|---|---|---|
| Siapa yang pakai | User yang login langsung ke Encompletion (JWT cookie) | End-user aplikasi klien, tidak pernah login ke Encompletion |
| Identitas | `users.id` internal | `external_user_id`, scoped ke satu `tenant` |
| Akses model | Bebas pilih dari model registry | Dikunci ke 1 model default per tenant |
| Tools | `Read/Write/Edit/Bash` (artifact generation) penuh | Kombinasi tools bisnis (tenant-specific) + opsional artifact generation terbatas |
| Project/session | Bisa lihat & pindah antar project miliknya | Hanya sesi miliknya sendiri di tenant itu |
| Persona | Default Encompletion | Custom per tenant (nama bot, gaya bicara) |
| Cara akses | Web app langsung | Widget/SDK yang ditanam di frontend aplikasi klien |

Prinsip desain: **jangan bikin sistem terpisah**. Tambahkan konsep
kepemilikan (`owner_type`) di atas skema yang sudah ada, bukan
duplikasi tabel.

---

## 2. Ownership Model

Tabel `projects` dan `sessions` yang sudah ada di Encompletion perlu
kolom polymorphic owner:

```sql
ALTER TABLE projects ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'; -- 'user' | 'tenant'
ALTER TABLE projects ADD COLUMN owner_id   TEXT NOT NULL;               -- users.id ATAU tenants.id

ALTER TABLE sessions ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
ALTER TABLE sessions ADD COLUMN owner_id   TEXT NOT NULL;

ALTER TABLE sessions ADD COLUMN external_user_id TEXT NULL; -- diisi hanya kalau owner_type = 'tenant'
```

Ini konsisten dengan pola migrasi idempotent yang sudah dipakai di
`backend/src/db/index.js` (`ALTER TABLE ADD COLUMN` kalau kolom belum
ada).

Semua query yang membaca `sessions`/`projects`/`messages`/`attachments`
harus difilter berdasarkan `owner_type` + `owner_id` — ini yang menjaga
isolasi data antar tenant maupun antara platform user dan tenant.

---

## 3. Tabel Baru

### 3.1 `tenants`
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| name | text | Nama aplikasi/klien |
| slug | text, unique | |
| status | text (active/suspended/trial) | |
| default_model_id | FK -> models.id | Model yang dikunci untuk embedded user tenant ini |
| persona_config | json | `{name, tone, greeting, ...}` — nama bot & gaya bicara custom |
| created_at, updated_at | timestamp | |

### 3.2 `tenant_api_keys`
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| tenant_id | FK -> tenants | |
| key_hash | text | Dipakai server-to-server (Laravel klien) untuk minta embed token |
| revoked_at | timestamp, nullable | |

### 3.3 `tenant_capability_profile`
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| tenant_id | FK -> tenants, unique | |
| allow_artifact_generation | boolean | Izinkan Kategori A (Read/Write/Edit) untuk embedded user tenant ini |
| allow_bash | boolean | Default false — hampir selalu harus false untuk embedded user |
| allowed_tool_ids | json (array) | Whitelist tool Kategori B yang aktif untuk tenant ini |
| max_context_tokens | integer | Override context budget RAG per tenant (lihat keputusan sebelumnya: default 6×600 char) |

### 3.4 `tools` (tool bisnis Kategori B, per tenant)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| tenant_id | FK -> tenants | |
| name | text | Mis. `input_transaksi`, `download_laporan` |
| description | text | |
| json_schema | json | Skema parameter |
| endpoint_url | text | Endpoint di aplikasi Laravel klien |
| tool_category | text ('business_action' \| 'content_generation') | Pembeda Kategori B vs A |
| requires_confirmation | boolean | |
| is_active | boolean | |

### 3.5 `tool_executions`
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| message_id | FK -> messages | |
| tool_id | FK -> tools | |
| input_params | json | |
| output | json, nullable | |
| status | text (pending_confirmation/confirmed/executed/failed/rejected) | |
| requested_at, executed_at | timestamp | |

### 3.6 `embed_tokens` (short-lived, untuk widget)
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | uuid, PK | |
| tenant_id | FK -> tenants | |
| external_user_id | text | |
| token_hash | text | |
| expires_at | timestamp | Short-lived, mis. 15-60 menit |
| created_at | timestamp | |

---

## 4. Alur Autentikasi Embed

Tenant API key **tidak pernah** dikirim ke browser end-user. Alurnya:

```
1. End-user login ke aplikasi Laravel klien (auth internal klien, bukan urusan Encompletion)
2. Backend Laravel klien -> POST /api/embed/token
   Header: Authorization: Bearer <tenant_api_key>   (server-to-server)
   Body:   { external_user_id: "..." }
3. Encompletion balas: { embed_token: "...", expires_at: "..." }
4. Backend Laravel klien kirim embed_token ke frontend-nya
5. Widget (di browser end-user) buka koneksi SSE ke Encompletion pakai embed_token
6. Encompletion resolve embed_token -> tenant_id + external_user_id -> terapkan capability profile
```

Ini pola yang sama dipakai widget chat pihak ketiga (Intercom/Crisp):
token sementara, bukan credential jangka panjang, di sisi browser.

---

## 5. Widget/SDK (baru)

Komponen baru yang tidak ada di codebase saat ini:

- **`widget.js`** — script kecil yang di-embed via `<script>` tag di
  frontend aplikasi klien, atau versi iframe. Tanggung jawab: terima
  `embed_token` dari host app, buka `EventSource` ke endpoint chat
  Encompletion, render UI chat minimal (bukan full UI Encompletion
  dengan sidebar/project browser).
- **Endpoint baru:** `POST /api/embed/token` (di atas), `GET
  /api/embed/session/:id/events` (SSE, mirip `/api/runs/:id/events` yang
  sudah ada tapi tervalidasi lewat `embed_token`, bukan JWT cookie).
- Middleware baru: `requireEmbedToken`, sejajar dengan `requireAuth`
  (JWT) dan `requireApiKey` (model API) yang sudah ada di `server.js`.

---

## 6. Dua Kategori Tool (tetap berlaku, diperjelas)

| | Kategori A — Content Generation | Kategori B — Business Action |
|---|---|---|
| Contoh | `Read/Write/Edit/Bash` (existing `tools.js`) | `input_transaksi`, `download_laporan` (baru, per tenant) |
| Eksekusi | Sandbox lokal server Encompletion | HTTP call ke endpoint aplikasi klien |
| Siapa yang biasa pakai | Platform user (penuh), embedded user (opsional, dibatasi `tenant_capability_profile`) | Embedded user (sesuai tool registry tenant) |
| Risiko utama | Egress ke jaringan internal — **`Bash` wajib tanpa akses ke endpoint tenant/credential vault manapun** | Validasi skema salah / bypass konfirmasi aksi sensitif |
| Isolasi | Workdir terpisah per `owner_type`+`owner_id`, auto-purge saat sesi archived | Tenant-scoped, audit log wajib di `tool_executions` |

Contoh alur gabungan (download laporan):
```
User (embed): "Buatkan laporan transaksi bulan ini"
  -> Tool Kategori B: get_laporan_data() -> HTTP ke Laravel -> data JSON
  -> Tool Kategori A: generate file xlsx dari data itu (kalau
     allow_artifact_generation = true untuk tenant ini)
  -> Artifact panel / link download dikirim ke user
```

---

## 7. RAG & Session — Penyesuaian Scope

Tidak ada perubahan mekanisme (chunking, embedding lokal via
`@xenova/transformers`, sliding window + compaction) — hanya perlu
scoping tambahan:

- `rag.js`: retrieval query wajib filter `owner_type` + `owner_id`
  (dan `tenant_id` turunannya), supaya knowledge base satu tenant tidak
  bocor ke tenant lain atau ke platform user.
- Context budget RAG (default: top-6 chunk × 600 char, ~3600 token) bisa
  di-override per tenant lewat `tenant_capability_profile.max_context_tokens`.
- Session compaction (`summary`, `last_activity_at`) berlaku sama untuk
  kedua owner type — idle timeout memicu ringkasan otomatis, terlepas
  apakah sesi itu milik platform user atau embedded end-user.
- Attachment tetap ephemeral (per-session, auto-purge saat archived) —
  keputusan ini berlaku untuk kedua mode.

---

## 8. Roadmap Penambahan Embed Mode

Roadmap ini **increment di atas** status Encompletion yang sudah ada
(Phase 1-5 selesai), bukan rebuild dari nol.

### Fase E1 — Fondasi Ownership
- [ ] Migrasi: tambah `owner_type`/`owner_id` di `projects`, `sessions`
- [ ] Tabel baru: `tenants`, `tenant_api_keys`
- [ ] Audit semua query existing (`sessions`, `messages`, `attachments`,
      `rag.js`) supaya konsisten filter by owner

### Fase E2 — Auth & Widget
- [ ] Endpoint `POST /api/embed/token` + tabel `embed_tokens`
- [ ] Middleware `requireEmbedToken`
- [ ] `widget.js` minimal: terima token, buka SSE, render chat sederhana
- [ ] Endpoint SSE embed (`/api/embed/session/:id/events`)

### Fase E3 — Capability Profile & Tool Kategori B
- [ ] Tabel `tenant_capability_profile`, `tools`, `tool_executions`
- [ ] `llm-runner.js`: bangun array `tools` dari registry tenant (bukan
      statis), terapkan pembatasan model/tool sesuai capability profile
- [ ] Tool executor generik untuk Kategori B: `executeHttpTool(config,
      params) -> POST endpoint_url`
- [ ] Alur konfirmasi untuk tool `requires_confirmation = true`

### Fase E4 — Isolasi Kategori A untuk Embed
- [ ] Workdir/sandbox terpisah per `owner_type`+`owner_id`
- [ ] `Bash` di-restrict: no network egress ke endpoint tenant/credential
      vault (whitelist domain kalau perlu akses registry npm dsb.)
- [ ] Toggle `allow_artifact_generation`/`allow_bash` per tenant
      benar-benar ditegakkan di tool loop

### Fase E5 — Persona, Analytics, Hardening
- [ ] `persona_config` per tenant diterapkan sebagai system prompt
      tambahan di embed mode
- [ ] Dashboard admin: kelola tenant, capability profile, tools,
      lihat `tool_executions`/audit log
- [ ] Rate limiting per tenant untuk endpoint embed
- [ ] Uji isolasi data lintas tenant secara eksplisit sebelum onboarding
      klien pertama

---

## 9. Ringkasan Perubahan dari Codebase Saat Ini

| File/area existing | Perubahan yang dibutuhkan |
|---|---|
| `db/index.js` | Tambah kolom owner + tabel baru (Fase E1, E3) |
| `tools.js` | Tetap ada (Kategori A), tambah executor generik Kategori B |
| `llm-runner.js` | Bangun `tools` array dinamis per owner/tenant, terapkan capability profile |
| `routes/` | Tambah `routes/embed.js` (token issuance + SSE embed) |
| `rag.js` | Tambah filter owner di query retrieval |
| `run-registry.js` | Tidak berubah — tetap in-memory per run, agnostik owner type |
| Frontend Next.js | Tidak berubah untuk platform mode; widget adalah paket terpisah, bukan bagian App Router utama |
