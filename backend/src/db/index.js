import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(__dirname, '../../data/claude-web.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Lightweight in-place migration for older DBs. Idempotent — each
// ALTER only fires once; subsequent boots become no-ops. Skip when
// the table does not exist yet (fresh volume); CREATE TABLE below
// already includes workdir.
const _cols = db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name);
if (_cols.length && !_cols.includes('workdir')) {
  db.exec('ALTER TABLE sessions ADD COLUMN workdir TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    default_model   TEXT DEFAULT 'workspace',
    theme           TEXT DEFAULT 'dark',
    language        TEXT DEFAULT 'id',
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    instructions  TEXT,
    color         TEXT DEFAULT '#3D348B',
    archived_at   DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS project_knowledge (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('text', 'file')),
    content     TEXT,
    file_path   TEXT,
    file_name   TEXT,
    mime_type   TEXT,
    size        INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title             TEXT,
    model             TEXT NOT NULL DEFAULT 'workspace',
    system_prompt     TEXT,
    workdir           TEXT,
    total_cost_usd    REAL DEFAULT 0,
    total_tokens      INTEGER DEFAULT 0,
    claude_session_id TEXT,
    starred           INTEGER NOT NULL DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at       DATETIME
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content       TEXT NOT NULL,
    cost_usd      REAL DEFAULT 0,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms   INTEGER,
    feedback      TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS message_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_name   TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size        INTEGER NOT NULL,
    content     TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tool_uses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_use_id TEXT,
    tool_name   TEXT NOT NULL,
    input       TEXT,
    output      TEXT,
    is_error    INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK(type IN ('html', 'jsx', 'svg', 'markdown', 'code', 'react', 'csv', 'file')),
    language    TEXT,
    title       TEXT,
    content     TEXT NOT NULL,
    version     INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);
`);

/**
 * Idempotent migrations for multi-user support.
 * Adds role/disabled/display_name/updated_at to users, user_id to sessions,
 * backfills existing rows to user_id=1 (admin), and creates ownership indexes.
 * Safe to run on every startup — checks column existence before ALTERing.
 */
function migrate() {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes("role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  }
  if (!userCols.includes("disabled")) {
    db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!userCols.includes("display_name")) {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  }
  if (!userCols.includes("updated_at")) {
    db.exec("ALTER TABLE users ADD COLUMN updated_at DATETIME");
  }
  if (!userCols.includes("last_login_at")) {
    db.exec("ALTER TABLE users ADD COLUMN last_login_at DATETIME");
  }

  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sessionCols.includes("user_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  }
  if (!sessionCols.includes("starred")) {
    db.exec("ALTER TABLE sessions ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
  }

  // Backfill: assign orphaned rows to first user (admin bootstrap).
  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  if (firstUser) {
    db.prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL').run(firstUser.id);
    db.prepare('UPDATE projects SET user_id = ? WHERE user_id IS NULL').run(firstUser.id);
  }

  // Promote the very first user to admin (covers legacy DBs where role defaulted to 'member')
  db.prepare(
    `UPDATE users SET role = 'admin'
       WHERE id = (SELECT id FROM users ORDER BY id ASC LIMIT 1)
         AND (SELECT COUNT(*) FROM users WHERE role = 'admin') = 0`
  ).run();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
  `);

  // Artifact noise reduction — add a content hash column so we can dedupe
  // identical blocks within the same session (Claude sometimes re-emits the
  // same snippet for emphasis or after editing). Hash is sha256 of content
  // + type (so same content with different language tag counts as different).
  const artCols = db.prepare("PRAGMA table_info(artifacts)").all().map((c) => c.name);
  if (!artCols.includes("content_hash")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN content_hash TEXT");
  }
  if (!artCols.includes("dup_of")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN dup_of INTEGER REFERENCES artifacts(id) ON DELETE SET NULL");
  }
  if (!artCols.includes("file_path")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN file_path TEXT");
  }
  if (!artCols.includes("mime_type")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN mime_type TEXT");
  }
  if (!artCols.includes("file_size")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN file_size INTEGER");
  }
  // Widen type CHECK to include 'file' on older DBs (SQLite CHECK is
  // table-level; rebuild only when the constraint text lacks 'file').
  {
    const artSql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`)
      .get()?.sql || '';
    if (artSql && !/'\s*file\s*'/.test(artSql) && /CHECK\s*\(\s*type\s+IN/i.test(artSql)) {
      db.exec(`
        BEGIN;
        CREATE TABLE artifacts_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          type        TEXT NOT NULL CHECK(type IN ('html', 'jsx', 'svg', 'markdown', 'code', 'react', 'csv', 'file')),
          language    TEXT,
          title       TEXT,
          content     TEXT NOT NULL,
          version     INTEGER DEFAULT 1,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          content_hash TEXT,
          dup_of      INTEGER REFERENCES artifacts_new(id) ON DELETE SET NULL,
          file_path   TEXT,
          mime_type   TEXT,
          file_size   INTEGER
        );
        INSERT INTO artifacts_new (
          id, session_id, message_id, type, language, title, content, version,
          created_at, updated_at, content_hash, dup_of, file_path, mime_type, file_size
        )
        SELECT
          id, session_id, message_id, type, language, title, content, version,
          created_at, updated_at, content_hash, dup_of,
          NULL, NULL, NULL
        FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_new RENAME TO artifacts;
        CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(session_id, content_hash);
        COMMIT;
      `);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts(session_id, content_hash)`);

  // Message feedback (thumbs up/down) — surfaced via the chat bubble.
  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  if (!msgCols.includes("feedback")) {
    db.exec("ALTER TABLE messages ADD COLUMN feedback TEXT");
  }

  // Cross-session recall (Phase 3) — the indexer-worker uses this to
  // find unindexed messages. NULL = needs embedding. Stamped by the
  // indexer after a successful upsert. Avoids re-embedding the same
  // turn on every poll tick.
  if (!msgCols.includes("last_indexed_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN last_indexed_at DATETIME");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_unindexed ON messages(last_indexed_at, id)`);

  // Recall hits per assistant message — sources actually surfaced from
  // the cross-session RAG recall block. JSON-encoded array of
  // {source_kind, source_id, label, score}. NULL means no recall was
  // available (short query, no hits above the score floor, or recall
  // was skipped). Used by the FE to render a "sources used" badge.
  if (!msgCols.includes("recall_hits")) {
    db.exec("ALTER TABLE messages ADD COLUMN recall_hits TEXT");
  }

  // Per-user customizable system prompt. NULL or empty string means "use
  // the hardcoded default in llm-runner.js" — no behavior change for
  // users who haven't customized. Read at chat time inside runLLM().
  const userSettingsCols = db.prepare("PRAGMA table_info(user_settings)").all().map((c) => c.name);
  if (!userSettingsCols.includes("system_prompt")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN system_prompt TEXT");
  }

  // Model registry — admin-curated list of models exposed in the chat
  // header dropdown. The Claude CLI flag is `--model <key>`, so `key` is the
  // raw model id (kebab-case) the backend passes through. Sessions store
  // this key verbatim, which keeps historical data legible even if labels
  // change later.
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled, sort_order);
  `);

  // Per-user LLM configuration — every authenticated user brings their own
  // provider endpoint + API key. base_url is plaintext (it shows up in
  // network tabs on every chat request anyway, so encrypting it adds no
  // security). api_key_blob is base64(AES-GCM iv || ciphertext || tag),
  // produced by crypto-secrets.js. A NULL api_key_blob means the user
  // has a base_url but no key yet — `configured` flips back to false so
  // the chat gate re-engages. compaction_model + extraction_model are
  // optional overrides; NULL = "use the user's first imported model".
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_llm_settings (
      user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      base_url         TEXT NOT NULL DEFAULT '',
      api_key_blob     TEXT,
      compaction_model TEXT,
      extraction_model TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_models (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      label       TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_models_enabled
      ON user_models(user_id, enabled, sort_order);
  `);

  // Project-level skill overrides: per-project opt-out list of skill
  // names from the global catalog. Stored as JSON text (SQLite has no
  // array type) — parsed at read time. All projects default to "[]",
  // i.e. the global skill set applies fully until the admin chooses
  // otherwise. Backed by the chat-time filter in runLLM so a model
  // never sees (or auto-loads) a skill the operator has silenced.
  const projCols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
  if (!projCols.includes("disabled_skills")) {
    db.exec("ALTER TABLE projects ADD COLUMN disabled_skills TEXT NOT NULL DEFAULT '[]'");
  }

  // RAG — semantic search over project knowledge + per-session
  // attachments. Vectors are stored as Float32 BLOB; the `dim` column is
  // checked on every insert and a mismatch wipes the table so we never
  // mix providers. embeddings_session makes attachment chunks ephemeral
  // — when a session is deleted, those rows go with it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings_chunk (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_id   INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT NOT NULL,
      vec         BLOB NOT NULL,
      dim         INTEGER NOT NULL,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_kind, source_id, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS embeddings_session (
      chunk_id   INTEGER NOT NULL REFERENCES embeddings_chunk(id) ON DELETE CASCADE,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      PRIMARY KEY(chunk_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings_chunk(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_emb_session ON embeddings_session(session_id);
  `);

  // Memory facts (Phase 1) — per-user persistent facts that flow into
  // every system prompt. v1 is manual-only via /api/memory; v2 will add
  // source='auto' rows extracted by an LLM at session end (backlog).
  // UNIQUE(user_id, key) means updates by key collide on the same row
  // — the upsert helper in memory.js relies on this.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memory_facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'manual'
                     CHECK(source IN ('manual', 'auto')),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_memory_facts_user
      ON user_memory_facts(user_id, key);
  `);

  // Memory auto-extraction (Phase 2) — per-user opt-out for auto-memory
  // (default ON so existing users see the feature without opting in).
  const userSettingsAutoCols = db.prepare("PRAGMA table_info(user_settings)").all().map((c) => c.name);
  if (!userSettingsAutoCols.includes("auto_memory_enabled")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN auto_memory_enabled INTEGER NOT NULL DEFAULT 1");
  }

  // Worker bookkeeping — when did we last run the extractor on this
  // session? Idle detection compares against sessions.updated_at so a
  // new user message re-arms extraction for the next poll tick.
  const sessionExtCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sessionExtCols.includes("last_memory_extracted_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_memory_extracted_at DATETIME");
  }

  // Conversation compaction (Phase 4) — one rolling summary per
  // session. PRIMARY KEY means the worker upserts in place rather
  // than accumulating. summarized_up_to records the messages.id at
  // the cutoff so the worker can rebuild summaries after deletes
  // without losing context.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id       INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary          TEXT NOT NULL,
      model            TEXT,
      summarized_up_to INTEGER NOT NULL,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Worker bookkeeping — bumped after each compaction run. The worker
  // uses (last_compacted_at < updated_at) to detect "session got new
  // messages since last compaction" without tracking a separate
  // "last message id compacted" pointer.
  if (!sessionExtCols.includes("last_compacted_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_compacted_at DATETIME");
  }

  // Memory facts (Phase 5) — per-project persistent facts that flow
  // into every chat whose session belongs to the project. UNIQUE
  // (project_id, key) means updates by key collapse to a single row,
  // same shape as user_memory_facts but scoped to project_id.
  // ON DELETE CASCADE matches the user-memory FK so deleting a
  // project wipes its facts. Manual-only in v1 (source=auto arrives
  // in Phase 6).
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_memory_facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'manual'
                    CHECK(source IN ('manual', 'auto')),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_project_memory_facts_project
      ON project_memory_facts(project_id, key);
  `);

  // App roles (users.role slugs). Platform admin stays the literal
  // slug 'admin' (requireAdmin + ownership SQL). Other rows are for
  // model RBAC + assignment only — no platform powers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      is_system   INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Seed built-ins. INSERT OR IGNORE keeps re-runs idempotent.
  const insRole = db.prepare(
    `INSERT OR IGNORE INTO roles (id, label, is_system, sort_order) VALUES (?, ?, ?, ?)`
  );
  insRole.run('admin', 'Admin', 1, 0);
  insRole.run('member', 'Member', 1, 1);

  // Role → model RBAC. Empty set for a role = unrestricted (all enabled).
  // Older DBs had CHECK(role IN ('admin','member')); rebuild if present
  // so custom role slugs can hold grants.
  {
    const rmExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='role_models'`)
      .get();
    if (!rmExists) {
      db.exec(`
        CREATE TABLE role_models (
          role       TEXT NOT NULL,
          model_key  TEXT NOT NULL,
          PRIMARY KEY (role, model_key)
        );
        CREATE INDEX IF NOT EXISTS idx_role_models_role ON role_models(role);
      `);
    } else {
      const sql = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='role_models'`)
        .get()?.sql || '';
      if (/CHECK\s*\(\s*role\s+IN/i.test(sql)) {
        db.exec(`
          BEGIN;
          CREATE TABLE role_models_new (
            role       TEXT NOT NULL,
            model_key  TEXT NOT NULL,
            PRIMARY KEY (role, model_key)
          );
          INSERT OR IGNORE INTO role_models_new (role, model_key)
            SELECT role, model_key FROM role_models;
          DROP TABLE role_models;
          ALTER TABLE role_models_new RENAME TO role_models;
          CREATE INDEX IF NOT EXISTS idx_role_models_role ON role_models(role);
          COMMIT;
        `);
      } else {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_role_models_role ON role_models(role);`);
      }
    }
  }
}

migrate();

export default db;
