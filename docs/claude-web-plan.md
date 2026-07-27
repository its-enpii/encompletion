# Claude Web: project plan & roadmap

> Web GUI untuk Claude Code CLI ke 9Router (ai.enpiistudio.com).  
> Stack: Node.js (backend) + Next.js (frontend) + SQLite/MySQL.

---

## Gambaran sistem

```
Browser (Next.js)
  ↕ Socket.IO + REST API
Node.js Backend (Express + Socket.IO)
  ↕ spawn process
Claude Code CLI
  ↕ ANTHROPIC_BASE_URL
9Router (ai.enpiistudio.com)
  ↕
Model AI (MiniMax M3, dll.)
```

---

## Fitur utama

- **Chat**: kirim prompt, terima response streaming dari Claude Code CLI
- **Attachment**: upload file sebagai context per message (text, image, PDF, code)
- **Artifact panel**: deteksi dan render artifact dari response (HTML, React, SVG, Markdown, code) di panel samping, mirip Claude.ai
- **Tool output**: tampilkan output Bash, Read, Write, WebSearch sebagai blok terpisah
- **Session**: simpan, lanjutkan, arsip conversation
- **Projects**: isolasi session per topik/project, share context antar session
- **Project knowledge**: dokumentasi, catatan, keputusan arsitektur per project
- **Model selector**: pilih model di 9Router
- **Cost & token**: monitor usage per session
- **System prompt**: instruksi global per session
- **Auth**: login sederhana; multi-user di phase lanjut

---

## Struktur Project

```
claude-web/
├── backend/                  # Node.js + Express
│   ├── src/
│   │   ├── server.js         # Entry point, HTTP + Socket.IO server
│   │   ├── claude-runner.js  # Spawn & stream Claude Code CLI
│   │   ├── routes/
│   │   │   ├── auth.js       # Login / logout
│   │   │   ├── sessions.js   # CRUD sessions
│   │   │   ├── messages.js   # Get messages per session
│   │   │   ├── projects.js   # CRUD projects
│   │   │   ├── knowledge.js  # CRUD project knowledge
│   │   │   ├── attachments.js # Upload & serve attachments
│   │   │   ├── artifacts.js  # CRUD artifacts per session
│   │   │   └── models.js     # List models dari 9Router
│   │   ├── db/
│   │   │   ├── index.js      # DB connection (better-sqlite3)
│   │   │   └── migrations/   # SQL migration files
│   │   └── middleware/
│   │       └── auth.js       # JWT middleware
│   ├── storage/
│   │   └── attachments/      # File upload storage
│   ├── .env
│   └── package.json
│
└── frontend/                 # Next.js 14 App Router
    ├── app/
    │   ├── page.tsx          # Redirect ke /chat
    │   ├── login/page.tsx    # Login page
    │   ├── projects/
    │   │   ├── page.tsx      # Daftar projects
    │   │   └── [id]/page.tsx # Detail project + knowledge
    │   └── chat/
    │       ├── page.tsx      # Chat list / new chat
    │       └── [id]/page.tsx # Chat session view
    ├── components/
    │   ├── ChatWindow.tsx       # Area output streaming
    │   ├── InputBar.tsx         # Prompt input + send + attachment
    │   ├── AttachmentPreview.tsx # Preview file sebelum kirim
    │   ├── ToolBlock.tsx        # Render tool output (Bash, Read, dll.)
    │   ├── ArtifactPanel.tsx    # Panel artifact di sebelah kanan chat
    │   ├── ArtifactViewer.tsx   # Render artifact (HTML iframe, SVG, Markdown, code)
    │   ├── ArtifactTabs.tsx     # Tab jika ada beberapa artifact per session
    │   ├── SessionList.tsx      # Sidebar daftar sessions
    │   ├── ProjectList.tsx      # Sidebar daftar projects
    │   ├── ModelSelector.tsx    # Dropdown pilih model
    │   └── TokenUsage.tsx       # Display cost & tokens
    └── lib/
        └── socket.ts         # Socket.IO client helper
```

---

## Database Schema

> Menggunakan **SQLite** (via better-sqlite3): cukup untuk personal use, zero config.  
> Bisa migrasi ke MySQL nantinya jika dibutuhkan.

### Tabel `users`
```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,         -- bcrypt hash
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `user_settings`
```sql
CREATE TABLE user_settings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_model   TEXT DEFAULT 'workspace',
  default_project_id INTEGER REFERENCES projects(id),
  theme           TEXT DEFAULT 'dark',   -- dark | light
  language        TEXT DEFAULT 'id',     -- id | en
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `projects`
```sql
CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,           -- e.g. "SIDBM", "Laundry SaaS"
  description   TEXT,                   -- ringkasan project
  instructions  TEXT,                   -- di-inject ke system prompt setiap session
  progress      TEXT,                   -- catatan progress & keputusan yang sudah dibuat
  color         TEXT DEFAULT '#3D348B', -- warna label di UI
  archived_at   DATETIME,               -- null = aktif
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `project_knowledge`
```sql
CREATE TABLE project_knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,            -- e.g. "ERD Database", "API Docs", "Keputusan Arsitektur"
  type        TEXT NOT NULL CHECK(type IN ('text', 'file')),
  content     TEXT,                     -- isi teks (jika type = text)
  file_path   TEXT,                     -- path file di server (jika type = file)
  file_name   TEXT,                     -- nama file asli
  mime_type   TEXT,                     -- jenis file
  size        INTEGER,                  -- ukuran file (bytes)
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `sessions`
```sql
CREATE TABLE sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title             TEXT,              -- auto-generate dari prompt pertama
  model             TEXT NOT NULL DEFAULT 'workspace',
  system_prompt     TEXT,             -- instruksi tambahan khusus session ini
  total_cost_usd    REAL DEFAULT 0,
  total_tokens      INTEGER DEFAULT 0,
  claude_session_id TEXT,             -- session_id dari Claude Code CLI (untuk --resume)
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  archived_at       DATETIME          -- null = aktif
);
```

### Tabel `messages`
```sql
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content       TEXT NOT NULL,
  cost_usd      REAL DEFAULT 0,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_ms   INTEGER,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `message_attachments`
```sql
CREATE TABLE message_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,           -- nama file asli
  file_path   TEXT NOT NULL,           -- path di storage/attachments/
  mime_type   TEXT NOT NULL,           -- text/plain, image/png, application/pdf, dll.
  size        INTEGER NOT NULL,        -- ukuran file (bytes)
  content     TEXT,                    -- isi file (untuk teks/code, di-inject ke prompt)
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `tool_uses`
```sql
CREATE TABLE tool_uses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,           -- Bash, Read, Write, WebSearch, WebFetch, dll.
  input       TEXT,                    -- JSON input ke tool
  output      TEXT,                    -- output dari tool
  is_error    INTEGER DEFAULT 0,       -- 0 = success, 1 = error
  duration_ms INTEGER,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `artifacts`
```sql
CREATE TABLE artifacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK(type IN ('html', 'jsx', 'svg', 'markdown', 'code')),
  language    TEXT,                    -- bahasa pemrograman (untuk type = code), e.g. js, php, sql
  title       TEXT,                   -- auto-generate atau dari comment pertama di code block
  content     TEXT NOT NULL,          -- isi artifact (raw code/markup)
  version     INTEGER DEFAULT 1,      -- versi artifact (jika diupdate Claude di turn berikutnya)
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Tabel `models`
```sql
CREATE TABLE models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id    TEXT NOT NULL UNIQUE,   -- e.g. "workspace", "claude-sonnet-4-6"
  label       TEXT,                   -- display name
  is_active   INTEGER DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

### Relasi Antar Tabel

```
users
  ├── user_settings (1:1)
  ├── projects (1:N)
  │     └── project_knowledge (1:N)
  └── sessions (1:N)
        ├── project (N:1) → projects
        ├── artifacts (1:N)
        └── messages (1:N)
              ├── message_attachments (1:N)
              ├── tool_uses (1:N)
              └── artifacts (1:N)
```

---

## Roadmap

### Phase 1: Foundation (Week 1)
> Claude dari browser, output streaming

- [ ] Setup project structure (backend + frontend)
- [ ] Node.js backend: spawn Claude Code CLI + stream stdout
- [ ] Socket.IO server: bridge CLI output ke browser (dengan auto-reconnect)
- [ ] Frontend: install `socket.io-client`, basic chat UI (input + output area)
- [ ] Test end-to-end: ketik prompt di browser → Claude respond streaming
- [ ] Setup SQLite + migration semua tabel

### Phase 2: Session & Project Management (Week 2)
> Conversation tersimpan, session dikelompokkan per project

- [ ] REST API: CRUD sessions & projects
- [ ] Simpan messages ke database
- [ ] Sidebar daftar sessions & projects
- [ ] Auto-generate title dari prompt pertama
- [ ] Lanjutkan session (`--resume` flag Claude Code CLI)
- [ ] Arsip / hapus session & project
- [ ] Project knowledge: tambah, edit, hapus teks/file knowledge
- [ ] Inject project instructions + knowledge ke system prompt saat session dimulai

### Phase 3: Auth & Config (Week 2-3)
> Aman diakses dari internet

- [ ] Login page (single user / personal)
- [ ] JWT authentication
- [ ] User settings (default model, theme)
- [ ] Nginx reverse proxy + SSL (domain kamu)
- [ ] Model selector (fetch dari 9Router `/v1/models`)

### Phase 4: Attachment, Tool Output & Artifacts (Week 3)
> Upload file, tool output, artifact panel di UI

- [ ] Upload attachment di input bar (drag & drop + klik)
- [ ] Preview attachment sebelum kirim
- [ ] Inject isi file ke prompt Claude
- [ ] Parse tool_use events dari stream-json Claude Code
- [ ] Simpan tool_uses ke database
- [ ] Render tool output sebagai blok collapsible di UI (Bash, Read, Write, WebSearch)
- [ ] Deteksi artifact dari response Claude (parse code block berdasarkan bahasa)
- [ ] Simpan artifact ke database
- [ ] Emit event `artifact` via Socket.IO ke frontend saat artifact terdeteksi
- [ ] Artifact panel di sebelah kanan chat (split view)
- [ ] Render artifact: HTML di iframe sandbox, SVG inline, Markdown, code dengan syntax highlight
- [ ] Tab artifact jika ada beberapa artifact per session
- [ ] Tombol copy, download, fullscreen per artifact

### Phase 5: UX (Week 4)
> Bisa dipakai harian

- [ ] System prompt per session
- [ ] Token & cost tracker per session + total
- [ ] Markdown rendering untuk response
- [ ] Code block dengan syntax highlighting
- [ ] Copy response / export session ke markdown
- [ ] Dark mode (default)
- [ ] Mobile-friendly layout

### Phase 6: Advanced (opsional, setelah Phase 5 stabil)
> Multi-user dan fitur tambahan

- [ ] Multi-user support (tim: Roku, Fandi, Faril, Agil)
- [ ] Multi-model comparison (prompt sama ke 2 model)
- [ ] Tagging & search sessions
- [ ] Webhook / notifikasi Telegram saat task panjang selesai
- [ ] Integrasi n8n

---

## Tech Stack

| Layer | Tech | Alasan |
|---|---|---|
| Frontend | Next.js 14 (App Router) | Sudah familiar, SSR + streaming support |
| Styling | Tailwind CSS | Cepat, utility-first |
| Backend | Node.js + Express | Native untuk spawn process + Socket.IO |
| Realtime | Socket.IO | Auto-reconnect, event system rapi, rooms support |
| Database | SQLite (better-sqlite3) | Zero config, cukup untuk personal |
| Auth | JWT + bcrypt | Simple, stateless |
| Process | Claude Code CLI | Engine utama |
| AI Gateway | 9Router (ai.enpiistudio.com) | Custom model routing |
| Deploy | Nginx + PM2 | Reverse proxy + process manager |
| SSL | acme.sh | Sudah familiar |

---

## Environment Variables

```env
# Backend (.env)
PORT=4000
JWT_SECRET=your-secret-key
ANTHROPIC_BASE_URL=https://ai.enpiistudio.com
ANTHROPIC_API_KEY=sk-...
DB_PATH=./data/claude-web.db
STORAGE_PATH=./storage/attachments
DEFAULT_MODEL=workspace
MAX_ATTACHMENT_SIZE_MB=10
```

---

## Estimasi Waktu

| Phase | Estimasi | Deliverable |
|---|---|---|
| Phase 1 | 2-3 hari | CLI bisa diakses dari browser, streaming jalan |
| Phase 2 | 3-4 hari | Session + Project tersimpan, knowledge ter-inject |
| Phase 3 | 1-2 hari | Auth + deploy ke domain |
| Phase 4 | 4-5 hari | Attachment + tool output + artifact panel |
| Phase 5 | 3-5 hari | UI lengkap, dipakai harian |
| Phase 6 | Ongoing | Fitur tambahan sesuai kebutuhan |

**Total Phase 1-5: ~2.5 minggu** (sambil kerja, part-time)

---

## Referensi Format JSON Output Claude Code CLI

> Hasil test nyata dari VPS dengan command:
> ```bash
> ANTHROPIC_BASE_URL=https://ai.enpiistudio.com \
> ANTHROPIC_API_KEY=sk-... \
> claude -p "hello" --model workspace --output-format stream-json --verbose
> ```

### Event 1: `system` (init)
```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/home/enpii",
  "session_id": "6a10b3dc-22ec-45b2-ba9a-31a853ab9469",
  "tools": ["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","Monitor","NotebookEdit","PushNotification","Read","ScheduleWakeup","SendMessage","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WebFetch","WebSearch","Workflow","Write"],
  "mcp_servers": [],
  "model": "workspace",
  "permissionMode": "default",
  "slash_commands": ["deep-research","design-sync","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator","clear","compact","config","context","heapdump","init","reload-skills","review","security-review","usage","insights","goal","team-onboarding"],
  "apiKeySource": "ANTHROPIC_API_KEY",
  "claude_code_version": "2.1.191",
  "output_style": "default",
  "agents": ["claude","Explore","general-purpose","Plan","statusline-setup"],
  "skills": ["deep-research","design-sync","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator"],
  "plugins": [],
  "uuid": "0e84a475-d327-4a7b-aa21-3f53ff0e1084",
  "memory_paths": {
    "auto": "/home/enpii/.claude/projects/-home-enpii/memory/"
  },
  "fast_mode_state": "off"
}
```
> **Yang dipakai**: `session_id`, `model`, `claude_code_version`, `cwd`

---

### Event 2: `assistant` (response AI)
```json
{
  "type": "assistant",
  "message": {
    "id": "068bb6506149cb20175880c5a9b538d2",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "hello"
      }
    ],
    "model": "MiniMax-M3",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "service_tier": "standard"
    }
  },
  "parent_tool_use_id": null,
  "session_id": "6a10b3dc-22ec-45b2-ba9a-31a853ab9469",
  "uuid": "c0cb9e05-e903-4400-880f-6a1681e2db31"
}
```
> **Yang dipakai**: `message.content[].text` (teks response), `message.model` (model aktual = `MiniMax-M3`)

---

### Event 3: `result` (summary akhir)
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "api_error_status": null,
  "duration_ms": 8641,
  "duration_api_ms": 8318,
  "ttft_ms": 8630,
  "ttft_stream_ms": 8628,
  "time_to_request_ms": 338,
  "num_turns": 1,
  "result": "hello",
  "stop_reason": "end_turn",
  "session_id": "6a10b3dc-22ec-45b2-ba9a-31a853ab9469",
  "total_cost_usd": 0.111494,
  "usage": {
    "input_tokens": 22276,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 128,
    "output_tokens": 2,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard"
  },
  "modelUsage": {
    "workspace": {
      "inputTokens": 22276,
      "outputTokens": 2,
      "cacheReadInputTokens": 128,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.111494,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "terminal_reason": "completed",
  "fast_mode_state": "off",
  "uuid": "ee59fd29-69a2-4bc9-b6e6-07d3060434b5"
}
```
> **Yang dipakai**: `total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, `duration_ms`, `session_id`, `is_error`

---

### Cara Parse di Node.js (`claude-runner.js`)

```js
proc.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  lines.forEach(line => {
    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'system') {
        // Simpan session_id ke DB, emit info init ke client
        onData({ type: 'system', session_id: parsed.session_id, model: parsed.model });
      }

      if (parsed.type === 'assistant') {
        // Stream teks response ke browser
        const blocks = parsed.message?.content || [];
        blocks.forEach(block => {
          if (block.type === 'text') {
            onData({ type: 'text', text: block.text });
          }
        });
      }

      if (parsed.type === 'result') {
        // Simpan cost + token usage ke DB
        onData({
          type: 'result',
          is_error: parsed.is_error,
          cost: parsed.total_cost_usd,
          duration_ms: parsed.duration_ms,
          input_tokens: parsed.usage.input_tokens,
          output_tokens: parsed.usage.output_tokens,
          session_id: parsed.session_id,
        });
      }

    } catch {
      onData({ type: 'raw', text: line });
    }
  });
});
```

---

### Catatan Penting dari Test

- Model `workspace` di 9Router adalah alias ke **MiniMax-M3**
- Cost untuk prompt "hello" = **$0.111494** (input tokens tinggi karena system prompt Claude Code besar ~22K tokens)
- `contextWindow`: 200,000 tokens, `maxOutputTokens`: 32,000
- Claude Code version yang terinstall: **2.1.191**
- Flag yang dibutuhkan: `--output-format stream-json --verbose` (tanpa `--verbose` akan error)

---

## Catatan

- **Keamanan**: Claude Code CLI akses filesystem server. Auth harus kuat; jangan expose port 4000 ke internet. Selalu lewat Nginx.
- **Cost**: Model `workspace` (MiniMax M3) di 9Router ~$0.111 per session "hello". Monitor usage dari Phase 5.
- **Resume session**: Claude Code CLI support `--resume <session_id>` untuk lanjut conversation yang sama.
- **Socket.IO events**: `prompt` (kirim), `stream` (chunk), `done` (selesai + cost), `error`, `stop` (cancel). Auto-reconnect kalau VPS putus.
- **Project context**: Saat session di dalam project, `instructions` + `project_knowledge` di-inject sebagai system message sebelum prompt user.
- **Attachment**: Isi file di-prepend ke prompt user sebelum dikirim ke CLI.
- **Tool output**: Event `tool_use` dari stream-json di-parse, disimpan ke `tool_uses`, ditampilkan sebagai blok collapsible.
- **Artifact detection**: Parse code block (```html, ```jsx, ```svg, ```md) → artifact → emit Socket.IO `artifact` → simpan ke DB.
- **Artifact versioning**: Update artifact di turn berikutnya increment `version`; UI bisa tampil history.
- **HTML sandbox**: Render di `<iframe sandbox="allow-scripts">` supaya terisolasi dari halaman utama.
- **Multi-user (Phase 6)**: Schema sudah pakai `user_id` di tabel utama.
