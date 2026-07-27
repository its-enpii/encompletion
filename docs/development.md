# Development Guide

## Setup Lokal (tanpa Docker)

### Backend

```bash
cd backend
npm install
cp .env.example .env   # lalu isi OPENAI_API_KEY & OPENAI_BASE_URL
npm run dev            # node --watch src/server.js
```

Jalan di `http://localhost:4000`. Frontend dev server proxy `/api` ke sini.

### Frontend

```bash
cd frontend
npm install
npm run dev            # next dev
```

Jalan di `http://localhost:3000`. Login pertama: `admin` / `admin12345` (dev only), atau `BOOTSTRAP_PASSWORD` kalau di-set.

### Nginx (opsional, untuk test SSE buffering)

Dev biasanya cukup backend + frontend. Nginx relevan di produksi: konfigurasi SSE (`proxy_buffering off`) sering bermasalah di reverse proxy lain.

## Testing

Backend pakai Node's built-in test runner. Tidak ada framework test tambahan.

```bash
cd backend
node --test src/rag.test.js
node --test src/run-registry.test.js
node --test src/api-keys.test.js
node --test src/system-prompt.test.js
```

Atau sekaligus:

```bash
node --test src/*.test.js
```

Cakupan: chunker/embedder RAG, lifecycle run-registry, hash + scope API key, format system prompt.

## Struktur kode

- `backend/src/llm-runner.js`: header file dokumentasi vocabulary event frontend. Event baru: update header + `frontend/src/lib/runStream.ts`.
- `backend/src/run-registry.js`: run in-memory, hilang saat restart. Frontend reconnect minta replay dari `lastSeq`.
- `backend/src/db/index.js`: kolom baru: blok `if (!_cols.includes(...)) ALTER TABLE ...` di atas `CREATE TABLE`. Idempotent.

## Debugging SSE

Stream muncul satu chunk lalu diam:

1. Nginx: `proxy_buffering off` di location block, response header `X-Accel-Buffering: no`.
2. Backend: `res.setHeader('Cache-Control', 'no-cache')`, `res.setHeader('Connection', 'keep-alive')`, flush tiap event.
3. Coba tanpa Nginx dulu: `http://localhost:4000/api/runs/:id/events`.

## Tambah Tool Baru

1. Implement di `backend/src/tools.js`: handler async `(input, ctx) => result`.
2. Daftarkan di schema di `llm-runner.js` (tools array di body request).
3. Handle event `tool_use` / `tool_result` di `frontend/src/components/ToolBlock.tsx` kalau perlu render khusus.

## Tambah Model

UI: login admin → `/models` → tambah. Isi `key` (mis. `claude-sonnet-5`), `label`, `base_url`, `api_key`. Atau set provider di `.env`; registry cuma alias yang user boleh pilih.

## Ganti Provider

Ubah `OPENAI_BASE_URL` + `OPENAI_API_KEY` di `.env`. Provider harus expose `POST /chat/completions` streaming `data: {...}\n\n`. Kode tidak perlu diubah.

## Konvensi

- Backend: ESM (`"type": "module"`), `node:` prefix untuk builtin (`node:fs`, `node:path`), JSDoc untuk exported function.
- Frontend: App Router, `"use client"` hanya di komponen yang pakai hook/interaksi, prefer Server Component default.
- Commit: bahasa Inggris, imperative subject, body jelaskan **why** bukan **what**.

## Catatan

- Jangan commit `.env` atau file SQLite. Sudah di `.gitignore`.
- Production: set `JWT_SECRET` persistent + `BOOTSTRAP_PASSWORD`. Tanpa `BOOTSTRAP_PASSWORD` di `NODE_ENV=production`, boot throw.
- `backend/data/` (SQLite + uploads) di-mount volume di docker-compose. Backup sebelum redeploy kalau data penting.
