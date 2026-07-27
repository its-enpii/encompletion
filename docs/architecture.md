# Arsitektur Encompletion

## Perubahan Arsitektur

Awalnya backend spawn subprocess `claude --output-format stream-json` dan pipe ke browser lewat SSE. Engine sekarang **OpenAI-compatible HTTP chat-completions**: provider yang expose endpoint itu (9Router, OpenAI, dll.) tinggal diisi lewat `OPENAI_BASE_URL` + `OPENAI_API_KEY`.

`backend/src/llm-runner.js` menggantikan `claude-runner.js` dan memakai vocabulary event yang sama (`text`, `tool_use`, `tool_result`, `result`, `stderr`). SSE handler di `server.js` dan frontend `Chat/index.tsx` tidak perlu diubah.

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

- **`server.js`**: bootstrap admin pertama kalau `users` kosong, mount router `/api/*`, SSE di `/api/runs/:id/events`. `requireAuth` (JWT) untuk route privat; `requireApiKey` untuk `/v1`.
- **`llm-runner.js`**: HTTP streaming chat-completions. Bangun pesan (system + history + hasil tool), loop sampai model berhenti minta tool, emit `text`/`tool_use`/`tool_result`/`result` lewat `EventEmitter`. Controller expose `{ kill, proc }` supaya `server.js` bisa persist pesan + cancel.
- **`db/index.js`**: SQLite WAL, migrasi in-place idempotent (`ALTER TABLE ADD COLUMN` kalau kolom belum ada). Skema: `users`, `user_settings`, `projects`, `sessions`, `messages`, `attachments`, `artifacts`, `api_keys`, `models`, `skills`.
- **`run-registry.js`**: peta runId → emitter, supaya SSE handler push event dari runner di request terpisah.
- **`tools.js`** + **`skill_loader.js`**: tool ke model (`Read`, `Write`, `Edit`, `Bash`, `Skill.list`, `Skill.read`). Skill di `$HOME/.enllm/skills/` (global per user, bukan per session).
- **`rag.js`**: chunk dokumen per project, embed `@xenova/transformers`, retrieve top-k saat prompt masuk.

### Frontend

- **`app/layout.tsx`** + **`AuthGate.tsx`**: cek cookie JWT, redirect `/login` kalau belum auth.
- **`app/chat/[id]/page.tsx`** + **`components/Chat/`**: UI utama. `runStream.ts` buka `EventSource`; `MessageList` bubble + tool block + artifact card; `Composer` input + attachment.
- **`components/Sidebar/`**: daftar project, session, pencarian.
- **`components/ArtifactPanel.tsx`**: split-pane kanan preview artifact (HTML/React/SVG/Markdown).
- **`app/settings/api-keys/`**: admin buat API key scoped per model; user hit `POST /v1/chat/completions`.

## SSE vs Socket.IO

Repo pakai **SSE** (server→client) lewat `EventSource`, bukan Socket.IO. Chat hanya butuh stream dari server; client kirim lewat HTTP POST. SSE + REST cukup, dan lebih mudah di balik Nginx.

## Auth Dua Jalur

1. **JWT cookie**: login browser. Middleware `requireAuth`.
2. **API key**: header `Authorization: Bearer enc_...`. Middleware `requireApiKey`, lookup `api_keys`, lock model ke `model_id` di key. Untuk `POST /v1/chat/completions` (OpenAI-compatible).

## Environment Variables (backend)

| Var | Wajib | Default | Keterangan |
|---|---|---|---|
| `OPENAI_API_KEY` | ya | (wajib) | API key provider |
| `OPENAI_BASE_URL` | ya | (wajib) | Mis. `https://ai.enpiistudio.com/v1` |
| `PORT` | tidak | `4000` | Port internal (Nginx di depan) |
| `DB_PATH` | tidak | `data/claude-web.db` | Path SQLite |
| `BOOTSTRAP_USERNAME` | tidak | `admin` | User pertama saat DB kosong |
| `BOOTSTRAP_PASSWORD` | production | `admin12345` (dev) | Password user pertama; wajib di-set di production |
| `JWT_SECRET` | production | random | Signing key; set persistent di production |
| `NODE_ENV` | tidak | `development` | `production` menegakkan `BOOTSTRAP_PASSWORD` |

## Deployment

`docker-compose.yml` menjalankan tiga service: `backend`, `frontend` (Next standalone), `nginx`. Nginx listen di `:8010` dan `:8082`, reverse-proxy SSE ke backend dengan `proxy_buffering off` dan `X-Accel-Buffering: no` agar stream tidak macet. Watchdog reload Nginx kalau upstream berubah (lihat `nginx/nginx.conf`).
