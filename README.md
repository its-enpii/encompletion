# Claude Web

Web GUI untuk Claude Code CLI yang terhubung ke 9Router (ai.enpiistudio.com).

## Stack

- Backend: Node.js + Express + Socket.IO + SQLite (better-sqlite3)
- Frontend: Next.js 16 (App Router) + Socket.IO client + Tailwind v4
- Proxy: Nginx (expose port **8008** & **8082**)
- Engine: Claude Code CLI (di-install di dalam container backend)

## Cara Jalankan

```bash
# 1. Edit API key
# backend/.env
# ANTHROPIC_API_KEY=sk-...

# 2. Build & start
docker compose up -d --build

# 3. Buka browser
# http://localhost:8008  atau  http://localhost:8082
```

## Struktur

```
backend/        Node.js + Express + Socket.IO
  src/server.js
  src/claude-runner.js   Spawn & parse stream-json dari `claude` CLI
  src/db/index.js        SQLite schema (sessions, messages)
frontend/       Next.js 16 App Router
  src/app/page.tsx       Chat UI
  src/components/Chat.tsx
  src/lib/socket.ts      Socket.IO client
nginx/nginx.conf         Reverse proxy
docker-compose.yml       Orchestration
```

## Phase Status

- [x] Phase 1 — Foundation (CLI streaming via browser)
- [ ] Phase 2 — Session & Project Management
- [ ] Phase 3 — Auth & Deploy
- [ ] Phase 4 — Attachment, Tool Output & Artifacts
- [ ] Phase 5 — UX & Power Features
- [ ] Phase 6 — Advanced (multi-user, dll.)

Lihat `docs/claude-web-plan.md` untuk detail lengkap.
