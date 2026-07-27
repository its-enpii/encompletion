# Encompletion

Web GUI chat AI multi-user. Awalnya pembungkus Claude Code CLI. Sekarang engine-nya HTTP chat-completions yang kompatibel OpenAI, jadi provider mana pun yang expose endpoint itu bisa dipakai (mis. 9Router / `ai.enpiistudio.com`). Backend Node + Express + SQLite, frontend Next.js 16, Nginx sebagai proxy.

## Stack

- **Backend**: Node.js + Express + Server-Sent Events + SQLite (`better-sqlite3`)
- **Frontend**: Next.js 16 (App Router) + EventSource + Tailwind v4 + React 19
- **Proxy**: Nginx (port **8010** & **8082**)
- **Engine**: OpenAI-compatible HTTP chat-completions
- **Auth**: JWT cookie + API key (akses publik `/v1`)

## Quick Start

```bash
# 1. Set API key + base URL provider
# backend/.env
# OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://ai.enpiistudio.com/v1
# BOOTSTRAP_USERNAME=admin
# BOOTSTRAP_PASSWORD=...   # wajib di production

# 2. Build & jalankan
docker compose up -d --build

# 3. Buka
# http://localhost:8010  atau  http://localhost:8082
```

## Fitur

- **Chat streaming** (SSE) dengan tool-use (Read/Write/Bash/Search) dan skill loader
- **Sessions & Projects**: percakapan dikelompokkan per project, masing-masing dengan `workdir` dan `instructions`
- **Attachments**: upload file (text, image, PDF, code, xlsx, docx) sebagai konteks per pesan
- **Artifacts**: HTML/React/SVG/Markdown dari respons ditampilkan di panel terpisah
- **Model registry**: admin daftarkan model dari provider; user pilih per sesi
- **API keys**: kunci scoped per model, untuk `POST /v1/chat/completions` (OpenAI-compatible)
- **Users & roles**: `admin` vs `user`, bootstrap user pertama otomatis
- **RAG**: chunking + embedding (`@xenova/transformers`), retrieval per project
- **Skills**: prosedur di `$HOME/.enllm/skills/`, dipanggil lewat `Skill.list` / `Skill.read`

## Struktur

```
backend/                Node + Express + SSE
  src/server.js         Bootstrap user, mount routers, SSE bridge
  src/llm-runner.js     OpenAI-compatible streaming + tool loop
  src/claude-runner.js  Legacy Claude CLI subprocess (kept for reference)
  src/db/index.js       SQLite schema + in-place migrations
  src/routes/           auth, users, sessions, projects, attachments,
                        skills, models, artifacts, api-keys, v1, runs
  src/tools.js          Built-in tool implementations
  src/skill_loader.js   Skill.list / Skill.read
  src/rag.js            Chunk + embed + retrieve
  src/artifact-detector.js
  src/run-registry.js   In-memory run state for streaming
frontend/               Next.js 16 App Router
  src/app/              Routes: /new, /chat/[id], /projects, /users,
                        /models, /settings/{api-keys,prompt}
  src/components/       Chat, Sidebar, ArtifactPanel, ToolBlock, dll.
  src/lib/              auth, store, runStream, models, api-keys
nginx/nginx.conf        Reverse proxy (SSE-buffering aware, watchdog)
docs/
  architecture.md       Arsitektur & alur data
  development.md        Setup lokal, testing, debugging
docker-compose.yml      Orchestration
```

## Phase Status

- [x] Phase 1: Foundation (CLI streaming via browser)
- [x] Phase 2: Session & Project Management
- [x] Phase 3: Auth & Deploy
- [x] Phase 4: Attachment, Tool Output & Artifacts
- [x] Phase 5: UX (skills, RAG, model registry, API keys)
- [ ] Phase 6: Advanced (multi-user, sharing, billing)

Detail di `docs/architecture.md` dan `docs/claude-web-plan.md`.

## Lisensi

Private.
