# Arsitektur Encompletion

## Perubahan Arsitektur

Proyek ini awalnya adalah pembungkus tipis untuk **Claude Code CLI**: backend spawn subprocess `claude --output-format stream-json` dan pipe hasilnya ke browser via SSE. Sekarang engine diganti ke **OpenAI-compatible HTTP chat-completions** — provider apa pun yang expose endpoint tersebut bisa dipakai (9Router, OpenAI, dll.) lewat `OPENAI_BASE_URL` + `OPENAI_API_KEY`.

`backend/src/llm-runner.js` menggantikan `claude-runner.js` dan meniru vocabulary event yang sama (`text`, `tool_use`, `tool_result`, `result`, `stderr`) supaya semua kode hilir — SSE handler `server.js`, frontend `Chat/index.tsx` — tidak perlu disentuh.

## Alur Data

```
┌─────────┐     SSE (EventSource)     ┌──────────────┐
│ Browser │ ────────────────────────▶  │ Express API  │
│ (Next)  │ ◀──────────────────────── │ (Node + SSE) │
└────┬────┘                            └──────┬───────┘
     │                                        │
     │ REST (auth JWT)                        │ fetch + ndjson stream
     ▼                                        ▼
┌─────────┐                            ┌──────────────────┐
│ /api/*  │  ← sessions, projects,    │ OpenAI-compat    │
│         │    messages, attachments   │ chat/completions │
└─────────┘                            │  (any provider)  │
                                       └─────────┬────────┘
                                                 │
                                          tool loop (server-side)
                                                 │
                                                 ▼
                                       ┌──────────────────┐
                                       │ tools.js         │
                                       │ skill_loader.js  │
                                       │ artifact-detect  │
                                       └──────────────────┘
```

## Komponen Utama

### Backend

- **`server.js`** — bootstrap admin user pertama kalau tabel `users` kosong, mount router di bawah `/api/*`, expose SSE untuk `/api/runs/:id/events`. Middleware `requireAuth` (JWT) membungkus route privat; `requireApiKey` membungkus `/v1`.
- **`llm-runner.js`** — HTTP streaming chat-completions. Membangun pesan (system + history + tool hasil), loop sampai model berhenti request tool, emit event `text`/`tool_use`/`tool_result`/`result` lewat `EventEmitter`. Controller expose `{ kill, proc }` agar `server.js` bisa persist pesan + cancel.
- **`db/index.js`** — SQLite WAL, in-place migration idempotent (`ALTER TABLE ADD COLUMN` kalau kolom belum ada). Skema: `users`, `user_settings`, `projects`, `sessions`, `messages`, `attachments`, `artifacts`, `api_keys`, `models`, `skills`.
- **`run-registry.js`** — peta runId → emitter, supaya SSE handler bisa push event dari runner yang di-spawn di tempat lain (request terpisah).
- **`tools.js`** + **`skill_loader.js`** — tool yang di-expose ke model (`Read`, `Write`, `Edit`, `Bash`, `Skill.list`, `Skill.read`). Skill hidup di `$HOME/.enllm/skills/` (global per user, bukan per session).
- **`rag.js`** — chunk dokumen per project, embed pakai `@xenova/transformers`, retrieve top-k saat prompt masuk.

### Frontend

- **`app/layout.tsx`** + **`AuthGate.tsx`** — cek cookie JWT, redirect ke `/login` kalau belum auth.
- **`app/chat/[id]/page.tsx`** + **`components/Chat/`** — UI utama. `runStream.ts` buka `EventSource`, `MessageList` render bubble + tool block + artifact card, `Composer` handle input + attachment.
- **`components/Sidebar/`** — daftar project, session dalam project, pencarian.
- **`components/ArtifactPanel.tsx`** — split-pane kanan untuk preview artifact (HTML/React/SVG/Markdown).
- **`app/settings/api-keys/`** — admin buat API key scoped per model; user pakai untuk hit `POST /v1/chat/completions`.

## SSE vs Socket.IO

Repo pakai **SSE** (one-way server→client) lewat `EventSource`, bukan Socket.IO. Alasan: chat butuh stream dari server, tapi tidak butuh push dari client di luar HTTP POST — SSE + REST sudah cukup dan lebih sederhana di balik Nginx.

## Auth Dua Jalur

1. **JWT cookie** — login browser biasa. `requireAuth` middleware.
2. **API key** — header `Authorization: Bearer enc_...`. `requireApiKey` middleware, lookup ke tabel `api_keys`, lock model ke `model_id` di key. Dipakai untuk `POST /v1/chat/completions` (OpenAI-compatible).

## Environment Variables (backend)

| Var | Wajib | Default | Keterangan |
|---|---|---|---|
| `OPENAI_API_KEY` | ya | — | API key provider |
| `OPENAI_BASE_URL` | ya | — | Mis. `https://ai.enpiistudio.com/v1` |
| `PORT` | tidak | `4000` | Port internal (Nginx di depan) |
| `DB_PATH` | tidak | `data/claude-web.db` | Path SQLite |
| `BOOTSTRAP_USERNAME` | tidak | `admin` | User pertama saat DB kosong |
| `BOOTSTRAP_PASSWORD` | production | `admin12345` (dev) | Password user pertama; wajib di-set di production |
| `JWT_SECRET` | production | random | Signing key; set persistent di production |
| `NODE_ENV` | tidak | `development` | `production` menegakkan `BOOTSTRAP_PASSWORD` |

## Deployment

`docker-compose.yml` jalankan tiga service: `backend`, `frontend` (Next standalone), `nginx`. Nginx listen di `:8010` dan `:8082`, reverse-proxy SSE ke backend dengan `proxy_buffering off` dan `X-Accel-Buffering: no` supaya stream tidak ke-stuck. Watchdog auto-reload Nginx saat upstream berubah (lihat `nginx/nginx.conf`).
