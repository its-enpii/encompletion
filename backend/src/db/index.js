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
// ALTER only fires once; subsequent boots become no-ops. Keep these
// at the top so every CREATE TABLE below sees the latest schema.
const _cols = db.prepare("PRAGMA table_info(sessions)").all().map((r) => r.name);
if (!_cols.includes('workdir')) {
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
    type        TEXT NOT NULL CHECK(type IN ('html', 'jsx', 'svg', 'markdown', 'code', 'react', 'csv')),
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

  // Per-user customizable system prompt. NULL or empty string means "use
  // the hardcoded default in llm-runner.js" — no behavior change for
  // users who haven't customized. Read at chat time inside runLLM().
  const userSettingsCols = db.prepare("PRAGMA table_info(user_settings)").all().map((c) => c.name);
  if (!userSettingsCols.includes("system_prompt")) {
    db.exec("ALTER TABLE user_settings ADD COLUMN system_prompt TEXT");
  }

  // Embed mode (E1) — polymorphic ownership so the same projects/sessions
  // tables can host both platform users (existing behavior) and tenant
  // end-users from embed widgets. owner_type='user' keeps the existing
  // semantics; owner_type='tenant' is wired up in later phases.
  //
  // owner_id is TEXT (uuid-ready) so we can store both integer users.id
  // (stringified) and tenant uuid keys in the same column.
  const projectCols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
  if (!projectCols.includes("owner_type")) {
    db.exec("ALTER TABLE projects ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'");
  }
  if (!projectCols.includes("owner_id")) {
    db.exec("ALTER TABLE projects ADD COLUMN owner_id TEXT");
  }
  // Backfill owner_id from existing user_id rows so the new index covers
  // everything we already had. Owners where user_id is NULL (legacy) get
  // pointed at the first admin so they remain visible.
  const ownerBackfillUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  if (ownerBackfillUser) {
    db.prepare(
      `UPDATE projects SET owner_type = 'user', owner_id = ?
         WHERE owner_id IS NULL OR owner_id = ''`
    ).run(String(ownerBackfillUser.id));
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_type, owner_id)`);

  const sessionCols2 = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sessionCols2.includes("owner_type")) {
    db.exec("ALTER TABLE sessions ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'");
  }
  if (!sessionCols2.includes("owner_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN owner_id TEXT");
  }
  if (!sessionCols2.includes("external_user_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN external_user_id TEXT");
  }
  if (ownerBackfillUser) {
    db.prepare(
      `UPDATE sessions SET owner_type = 'user', owner_id = ?
         WHERE owner_id IS NULL OR owner_id = ''`
    ).run(String(ownerBackfillUser.id));
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_type, owner_id)`);

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

  // Seed defaults once. Only inserts when the table is completely empty —
  // never overwrites whatever the admin has configured. The labels mirror
  // the previous hardcoded UI list so existing chats still resolve a label.
  const count = db.prepare('SELECT COUNT(*) AS n FROM models').get().n;
  // Seed defaults once. Only inserts when the table is completely empty —
  // never overwrites whatever the admin has configured.
  //
  // Why these specific keys: they are the IDs the engine's CLI accepts
  // out of the box. Generic names like 'standard' / 'fast' are NOT valid
  // upstream model ids and would cause every prompt to come back with
  // "issue with the selected model" — the user sees zero text and
  // thinks the app is broken. Keep keys aligned with what the CLI
  // understands; let admins rename the *label* freely in /models.
  if (count === 0) {
    const seed = db.prepare(
      `INSERT INTO models (key, label, enabled, sort_order) VALUES (?, ?, 1, ?)`
    );
    seed.run('workspace', 'Workspace', 0);
    seed.run('claude-sonnet-4-6', 'Sonnet 4.6', 10);
    seed.run('claude-haiku-4-5', 'Haiku 4.5', 20);
  }

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

  // API keys — per-user OpenAPI credentials. The plaintext key is shown
  // once at creation time; only its sha256 hash is stored. `model`
  // captures which model the key is locked to; mismatches from the
  // client are ignored (see routes/v1.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      model        TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      last_used_at DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at DESC);
  `);

  // Embed mode (E1.2) — tenants and their server-to-server API keys.
  // Browser widgets never see these: tenant_api_keys are only used by
  // the Laravel/saas-app backend when it POSTs /api/embed/token. The
  // single-use, short-lived embed_tokens are issued in phase E2.
  const tenantCols = db.prepare("PRAGMA table_info(tenants)").all().map((c) => c.name);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      slug             TEXT NOT NULL UNIQUE,
      status           TEXT NOT NULL DEFAULT 'active'
                          CHECK(status IN ('active', 'suspended', 'trial')),
      default_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
      persona_config   TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (!tenantCols.includes('created_by')) {
    db.exec("ALTER TABLE tenants ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_api_keys (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      key_hash   TEXT NOT NULL UNIQUE,
      revoked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant
      ON tenant_api_keys(tenant_id, created_at DESC);
  `);

  // Embed mode (E2) — short-lived tokens handed to the browser widget.
  // Issued by /api/embed/token (server-to-server) and presented back by
  // the widget for every subsequent SSE / POST. Never store the plaintext
  // token at rest — only its sha256 hash, and only for the brief window
  // the widget is expected to live.
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_tokens (
      id               TEXT PRIMARY KEY,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      external_user_id TEXT NOT NULL,
      token_hash       TEXT NOT NULL UNIQUE,
      expires_at       DATETIME NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_embed_tokens_tenant
      ON embed_tokens(tenant_id, external_user_id, expires_at DESC);
  `);

  // Embed mode (E3) — per-tenant capability profile. Decides what an
  // embedded user is allowed to do (Kategori A tools, Bash, which
  // Kategori B tools are active, RAG context budget override).
  // One row per tenant (UNIQUE tenant_id). Missing row = permissive
  // defaults: allow_artifact_generation=1, allow_bash=0, allowed_tool_ids
  // is empty (use tool.is_active filter only), max_context_tokens=NULL
  // (let the global RAG default apply).
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_capability_profile (
      id                       TEXT PRIMARY KEY,
      tenant_id                TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      allow_artifact_generation INTEGER NOT NULL DEFAULT 1,
      allow_bash                INTEGER NOT NULL DEFAULT 0,
      allowed_tool_ids          TEXT NOT NULL DEFAULT '[]',
      max_context_tokens        INTEGER,
      rate_limit_override       INTEGER,
      created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at                DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Add rate_limit_override idempotently to older DBs.
  const capCols = db.prepare("PRAGMA table_info(tenant_capability_profile)").all().map((c) => c.name);
  if (!capCols.includes('rate_limit_override')) {
    db.exec("ALTER TABLE tenant_capability_profile ADD COLUMN rate_limit_override INTEGER");
  }

  // Embed mode (E3) — Kategori B tools registered per tenant. tool_category
  // distinguishes content_generation (rare, tenant-specific tools that
  // produce files like a custom report builder) from business_action
  // (HTTP calls into the tenant's app — the common case for embed).
  // endpoint_url is the saas-app's own API the executor POSTs to.
  // json_schema is the parameter schema validated before each call.
  // requires_confirmation=true means the widget must show the user what
  // will happen and get an explicit confirm before the executor fires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tools (
      id                   TEXT PRIMARY KEY,
      tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      description          TEXT NOT NULL,
      json_schema          TEXT NOT NULL,
      endpoint_url         TEXT NOT NULL,
      tool_category        TEXT NOT NULL DEFAULT 'business_action'
                            CHECK(tool_category IN ('business_action', 'content_generation')),
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      is_active            INTEGER NOT NULL DEFAULT 1,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_tools_tenant
      ON tools(tenant_id, is_active);
  `);

  // Embed mode (E3) — audit log for every tool execution. Each row is one
  // HTTP call (or one Kategori A invocation, when those get added in E4).
  // status transitions: pending_confirmation → confirmed → executed,
  // or → rejected, or → failed. The widget UI shows the user which
  // tools fired in their session and lets them drill into the JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id            TEXT PRIMARY KEY,
      message_id    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      tool_id       TEXT REFERENCES tools(id) ON DELETE SET NULL,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      external_user_id TEXT,
      input_params  TEXT NOT NULL,
      output        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending_confirmation'
                       CHECK(status IN ('pending_confirmation', 'confirmed', 'executed', 'failed', 'rejected')),
      error_message TEXT,
      requested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at   DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_tool_executions_tenant
      ON tool_executions(tenant_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_message
      ON tool_executions(message_id, requested_at DESC);
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
}

migrate();

export default db;
