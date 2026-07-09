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
    type        TEXT NOT NULL CHECK(type IN ('html', 'jsx', 'svg', 'markdown', 'code', 'react')),
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
}

migrate();

export default db;
