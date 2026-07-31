# Encompletion

Web GUI chat AI multi-user. Awalnya pembungkus Claude Code CLI. Sekarang engine-nya HTTP chat-completions yang kompatibel OpenAI, jadi provider mana pun yang expose endpoint itu bisa dipakai (mis. 9Router / `ai.enpiistudio.com`). Backend Node + Express + SQLite, frontend Next.js 16, Nginx sebagai proxy.

Arah product: **agentic AI assistant** (baca/buat dokumen, planning, aksi terstruktur) — lihat `docs/roadmap-agent-assistant.md`.

## Stack

- **Backend**: Node.js + Express + Server-Sent Events + SQLite (`better-sqlite3`)
- **Frontend**: Next.js 16 (App Router) + EventSource + Tailwind v4 + React 19
- **Proxy**: Nginx (port **8010** & **8082**)
- **Engine**: OpenAI-compatible HTTP chat-completions
- **Auth**: JWT (cookie / Bearer)

## Quick Start

```bash
# 1. Set provider key + base URL
# backend/.env
# LLM_API_KEY=sk-...
# LLM_BASE_URL=https://ai.enpiistudio.com/v1
# BOOTSTRAP_USERNAME=admin
# BOOTSTRAP_PASSWORD=...   # wajib di production

# 2. Build & jalankan
docker compose up -d --build

# 3. Buka
# http://localhost:8010  atau  http://localhost:8082
```

## Fitur

- **Chat streaming** (SSE) dengan tool-use (Read/Write/Edit/Glob/Grep/Web*/EmitArtifact) dan skill loader
- **Sessions & Projects**: percakapan dikelompokkan per project, masing-masing dengan `workdir` dan `instructions`
- **Attachments**: upload file (text, image, PDF, code, xlsx, docx) sebagai konteks per pesan
- **Artifacts**: HTML/React/SVG/Markdown dari respons ditampilkan di panel terpisah
- **Model registry**: admin daftarkan model dari provider; user pilih per sesi
- **Users & roles**: `admin` vs `member`, bootstrap user pertama otomatis
- **RAG + memory**: chunking + embedding lokal, memory facts, session compaction
- **Skills**: prosedur di `$HOME/.enllm/skills/`, dipanggil lewat `Skill_list` / `Skill_read`

## Struktur

```
backend/                Node + Express + SSE
  src/server.js         Bootstrap user, mount routers
  src/llm-runner.js     OpenAI-compatible streaming + tool loop
  src/db/index.js       SQLite schema + in-place migrations
  src/routes/           auth, users, sessions, projects, attachments,
                        skills, models, artifacts, runs, memory
  src/tools.js          Built-in tool implementations
  src/skill_loader.js   Skill_list / Skill_read
  src/rag.js            Chunk + embed + retrieve
  src/artifact-detector.js
  src/run-registry.js   In-memory run state for streaming
frontend/               Next.js 16 App Router
  src/app/              Routes: /new, /chat/[id], /projects
  src/components/       Chat, Sidebar, ArtifactPanel, AdminPanel, dll.
  src/lib/              auth, store, runStream, models
nginx/nginx.conf        Reverse proxy (SSE-buffering aware)
docs/
  architecture.md
  development.md
  roadmap-agent-assistant.md
docker-compose.yml
```

## Roadmap status

- [x] Fase 1: Hapus API keys publik + tenant/embed
- [x] Fase 2: Generate PDF/XLSX/PPTX server-side (`CreateDocument`) + baca PPTX
- [x] Fase 3: Planning/PRD skills + mermaid render
- [x] Fase 4: Frontend flow rebuild (EmptyHero + suggestions)

Detail: `docs/roadmap-agent-assistant.md`.

## Lisensi

Private.
