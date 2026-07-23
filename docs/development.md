# Development Guide

## Setup Lokal (tanpa Docker)

### Backend

```bash
cd backend
npm install
cp .env.example .env   # lalu isi OPENAI_API_KEY & OPENAI_BASE_URL
npm run dev            # node --watch src/server.js
```

Boot di `http://localhost:4000`. Frontend dev server akan proxy `/api` ke sini.

### Frontend

```bash
cd frontend
npm install
npm run dev            # next dev
```

Boot di `http://localhost:3000`. Login pertama pakai `admin` / `admin12345` (dev only) atau `BOOTSTRAP_PASSWORD` kalau di-set.

### Nginx (opsional, untuk test SSE buffering)

Biasanya cukup jalankan backend + frontend tanpa Nginx saat dev. Nginx cuma relevan untuk produksi karena konfigurasi SSE-nya (`proxy_buffering off`) sering bikin masalah di reverse proxy lain.

## Testing

Backend pakai Node's built-in test runner — tidak ada framework tambahan.

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

Test memverifikasi: chunker/embedder RAG, lifecycle run-registry, hash + scope API key, format system prompt.

## Struktur Kode yang Patut Diketahui

- `backend/src/llm-runner.js` — header file mendokumentasikan vocabulary event yang dipakai frontend. Kalau tambah event baru, update header + `frontend/src/lib/runStream.ts`.
- `backend/src/run-registry.js` — Run disimpan in-memory, hilang saat restart. Frontend handle reconnect dengan minta replay event dari `lastSeq`.
- `backend/src/db/index.js` — Tambah kolom baru = tambah blok `if (!_cols.includes(...)) ALTER TABLE ...` di atas `CREATE TABLE`. Idempotent, aman di-boot ulang.

## Debugging SSE

Kalau stream muncul satu chunk lalu diam:

1. Cek Nginx: pastikan `proxy_buffering off` di location block, dan response kirim header `X-Accel-Buffering: no`.
2. Cek backend: `res.setHeader('Cache-Control', 'no-cache')`, `res.setHeader('Connection', 'keep-alive')`, flush tiap event.
3. Test tanpa Nginx dulu — langsung hit `http://localhost:4000/api/runs/:id/events`.

## Tambah Tool Baru

1. Implement di `backend/src/tools.js` — handler async `(input, ctx) => result`.
2. Daftarkan di schema di `llm-runner.js` (tools array di body request).
3. Handle event `tool_use` / `tool_result` di `frontend/src/components/ToolBlock.tsx` kalau perlu render khusus.

## Tambah Model

Lewat UI: login admin → `/models` → tambah. Isi `key` (mis. `claude-sonnet-5`), `label`, `base_url`, `api_key`. Atau set di `.env` provider langsung; model registry hanya daftarkan alias yang user boleh pilih.

## Ganti Provider

Cukup ubah `OPENAI_BASE_URL` + `OPENAI_API_KEY` di `.env`. Asalkan provider expose endpoint `POST /chat/completions` yang streaming `data: {...}\n\n`, tidak ada kode yang perlu diubah.

## Konvensi

- Backend: ESM (`"type": "module"`), `node:` prefix untuk builtin (`node:fs`, `node:path`), JSDoc untuk exported function.
- Frontend: App Router, `"use client"` hanya di komponen yang pakai hook/interaksi, prefer Server Component default.
- Commit: bahasa Inggris, imperative subject, body jelaskan **why** bukan **what**.

## Catatan Penting

- **Jangan** commit `.env` atau file SQLite. `.gitignore` sudah cover.
- **Production wajib** set `JWT_SECRET` persistent + `BOOTSTRAP_PASSWORD`. Tanpa `BOOTSTRAP_PASSWORD` di `NODE_ENV=production`, backend boot akan throw.
- File di `backend/data/` (SQLite + uploads) di-mount sebagai volume di docker-compose — backup sebelum redeploy kalau data penting.
