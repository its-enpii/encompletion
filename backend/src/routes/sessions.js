import express from 'express';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db/index.js';
import { ZipWriter } from '../zip-writer.js';
import rag from '../rag.js';

const router = express.Router();

const WORKDIR_ROOT = process.env.WORKDIR_ROOT
  ? path.resolve(process.cwd(), process.env.WORKDIR_ROOT)
  : path.resolve(process.cwd(), 'storage/workdirs');
fs.mkdirSync(WORKDIR_ROOT, { recursive: true });

// Validate a workdir request from the client. We require:
//   1. absolute path (relative paths get rejected so the model can never be
//      pointed at /etc/passwd by accident)
//   2. realpath inside WORKDIR_ROOT (or the user's default subdir there)
//
// Returns the canonical absolute path on success, null on rejection.
// An empty/undefined input returns the user's default workdir (created
// on demand).
function resolveWorkdir(user, requested) {
  const role = user.role || 'member';
  const defaultDir = role === 'admin'
    ? path.join(WORKDIR_ROOT, 'admin')
    : path.join(WORKDIR_ROOT, String(user.id));
  if (!requested || (typeof requested === 'string' && requested.trim() === '')) {
    return defaultDir;
  }
  if (typeof requested !== 'string') return null;
  let abs;
  try {
    abs = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(defaultDir, requested);
  } catch {
    return null;
  }
  let real;
  try { real = fs.realpathSync(path.dirname(abs)); } catch { real = path.dirname(abs); }
  const root = fs.realpathSync(WORKDIR_ROOT) + path.sep;
  // Must live under the workdir root, OR match the default subdir we
  // just computed (which may not exist yet and thus has no realpath).
  const defaultReal = path.resolve(defaultDir);
  if (
    !(real + path.sep).startsWith(root) &&
    abs !== defaultReal &&
    !(defaultReal + path.sep).startsWith(real + path.sep)
  ) {
    return null;
  }
  return abs;
}

// Build SQL fragment + params that limit rows to those owned by user unless admin.
// Returns { sql: ' AND (s.user_id = ? OR ? = \'admin\')', params: [userId, role] }
// Owner filter used by every read query. Platform users match on
// owner_type='user' + owner_id=user.id; embed tenant sessions will match
// on owner_type='tenant' (handled in routes/embed.js, not here). Admin
// sees everything under both owner types.
function ownedOrAdmin(user, alias = 's') {
  return {
    sql: ` AND (${alias}.owner_type = 'user' AND ${alias}.owner_id = ? OR ? = 'admin')`,
    params: [String(user.id), user.role || 'member'],
  };
}

function ownSessionOr404(sessionId, user) {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE id = ?
          AND (owner_type = 'user' AND owner_id = ? OR ? = 'admin')`
    )
    .get(sessionId, String(user.id), user.role || 'member');
}

// List sessions (optionally filter by project_id, exclude archived, search by title).
// Default cap is 50 — the sidebar renders this list directly and doesn't need
// the full history. Users looking for older sessions open the search dialog,
// which fetches with a `q` query for a wider LIKE search (separate limit).
router.get('/', (req, res) => {
  const { project_id, include_archived, q, limit } = req.query;
  const where = [];
  const params = [];
  if (project_id !== undefined && project_id !== '') {
    where.push('s.project_id = ?');
    params.push(Number(project_id));
  }
  if (!include_archived) where.push('s.archived_at IS NULL');
  const scope = ownedOrAdmin(req.user, 's');
  where.push('1=1'); // anchor for the scope fragment
  where.push(scope.sql.replace(/^ AND /, ''));
  params.push(...scope.params);

  // Title search (LIKE). Both sidebar-side filtering and the search dialog
  // route through this same endpoint, so the LIKE runs server-side and we
  // only ship matching rows.
  if (q && String(q).trim()) {
    where.push('(LOWER(s.title) LIKE ? OR CAST(s.id AS TEXT) LIKE ?)');
    const needle = `%${String(q).trim().toLowerCase()}%`;
    params.push(needle, needle);
  }

  // Cap is 50 by default (sidebar list); search dialog can request up to 500
  // via `?limit=500` to populate the dialog with a wider net.
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));

  // Hide empty placeholder sessions ("New chat" rows created when the user
  // lands on /new but never sends a message). They have no messages and
  // make the sidebar unreadable when a user opens several tabs without
  // typing. The first-turn error path (test 06) explicitly deletes the
  // session; this filter is a safety net for other paths that leak the
  // placeholder into the sidebar.
  where.push('EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)');

  const sql = `
    SELECT s.id, s.project_id, s.user_id, s.title, s.model, s.total_cost_usd, s.total_tokens,
           s.claude_session_id, s.starred, s.created_at, s.updated_at, s.archived_at,
           u.username AS owner_username
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.updated_at DESC
     LIMIT ${cap}
  `;
  res.json(db.prepare(sql).all(...params));
});

// Count of sessions matching the same filters as GET / (sidebar filter chip
// uses this to render the total behind a "show more" link without paying
// for the join + payload of the list endpoint). Cheap — single COUNT(*)
// against an indexed column, no JOIN.
router.get('/count', (req, res) => {
  const { project_id, include_archived } = req.query;
  const where = [];
  const params = [];
  if (project_id !== undefined && project_id !== '') {
    where.push('s.project_id = ?');
    params.push(Number(project_id));
  }
  if (!include_archived) where.push('s.archived_at IS NULL');
  const scope = ownedOrAdmin(req.user, 's');
  where.push('1=1');
  where.push(scope.sql.replace(/^ AND /, ''));
  params.push(...scope.params);
  // Mirror the empty-session filter on GET / so the count endpoint
  // stays in lock-step with the listing — otherwise the "show more"
  // link would advertise hidden rows that the user can't see or click
  // through to (they'd resolve to an empty placeholder).
  where.push('EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE ${where.join(' AND ')}`)
    .get(...params);
  res.json({ total: row.n });
});

// Create a new session
router.post('/', (req, res) => {
  const { title, model, project_id, system_prompt, workdir } = req.body || {};
  // If member attaches a project, ensure they own it
  if (project_id) {
    const own = db
      .prepare(
        `SELECT id FROM projects
          WHERE id = ? AND (user_id = ? OR ? = 'admin')`
      )
      .get(project_id, req.user.id, req.user.role || 'member');
    if (!own) return res.status(403).json({ error: 'project not accessible' });
  }
  // Sandbox: only allow workdirs under WORKDIR_ROOT, owned by this user
  // (admins may use the global root). Empty/missing → default per-user.
  const safeWorkdir = resolveWorkdir(req.user, workdir);
  if (workdir && !safeWorkdir) {
    return res.status(400).json({ error: 'invalid workdir' });
  }
  const info = db
    .prepare(
      `INSERT INTO sessions (title, model, project_id, system_prompt, user_id, workdir, owner_type, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?, ?)`
    )
    .run(
      title?.trim() || null,
      model || process.env.DEFAULT_MODEL || 'workspace',
      project_id || null,
      system_prompt || null,
      req.user.id,
      safeWorkdir,
      String(req.user.id),
      new Date().toISOString(),
      new Date().toISOString()
    );
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  // Eagerly create the directory so the first tool call doesn't race a mkdir.
  if (safeWorkdir) {
    try { fs.mkdirSync(safeWorkdir, { recursive: true }); } catch { /* ignore */ }
  }
  res.json(row);
});

// Get one session with messages
router.get('/:id', (req, res) => {
  const session = ownSessionOr404(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: 'not found' });
  const messages = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
    .all(req.params.id);
  res.json({ session, messages });
});

// Update session (title, project_id, system_prompt, archive)
router.patch('/:id', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });

  const { title, project_id, system_prompt, archived, starred, workdir } = req.body || {};
  // If changing project_id, ensure ownership
  if (project_id !== undefined && project_id !== null) {
    const projOk = db
      .prepare(
        `SELECT id FROM projects WHERE id = ? AND (user_id = ? OR ? = 'admin')`
      )
      .get(project_id, req.user.id, req.user.role || 'member');
    if (!projOk) return res.status(403).json({ error: 'project not accessible' });
  }

  const fields = [];
  const params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (project_id !== undefined) { fields.push('project_id = ?'); params.push(project_id); }
  if (system_prompt !== undefined) { fields.push('system_prompt = ?'); params.push(system_prompt); }
  if (starred !== undefined) { fields.push('starred = ?'); params.push(starred ? 1 : 0); }
  if (workdir !== undefined) {
    const safeWorkdir = resolveWorkdir(req.user, workdir);
    if (workdir && !safeWorkdir) return res.status(400).json({ error: 'invalid workdir' });
    fields.push('workdir = ?'); params.push(safeWorkdir);
    if (safeWorkdir) { try { fs.mkdirSync(safeWorkdir, { recursive: true }); } catch { /* ignore */ } }
  }
  if (archived !== undefined) {
    fields.push('archived_at = ?');
    params.push(archived ? new Date().toISOString() : null);
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(req.params.id);
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  // Archiving a session effectively scopes it out of the active list.
  // We don't drop the RAG chunks here — the session is still in the
  // DB and the user may unarchive it. The chunks live in
  // embeddings_session and follow the row's lifecycle (DELETE handler
  // below does the wipe).
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

// Toggle starred flag. Dedicated route so the sidebar can flip with one call
// without round-tripping the current value or PATCHing all session fields.
router.post('/:id/star', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const next = own.starred ? 0 : 1;
  db.prepare(
    `UPDATE sessions SET starred = ?, updated_at = ? WHERE id = ?`
  ).run(next, new Date().toISOString(), req.params.id);
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

// Delete session
router.delete('/:id', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  // Wipe ephemeral attachment RAG chunks before the row goes — the FK
  // on embeddings_session would also do this, but the FK path needs
  // the row delete to happen first; calling removeSource explicitly
  // keeps the operation observable in logs and avoids surprise churn.
  rag.removeSession(req.params.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Get messages + attached tool_uses (per message) + artifacts for a session
router.get('/:id/full', (req, res) => {
  const session = ownSessionOr404(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: 'not found' });
  const messages = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
    .all(req.params.id);
  const msgIds = messages.map((m) => m.id);
  const tools = msgIds.length
    ? db
        .prepare(
          `SELECT * FROM tool_uses WHERE message_id IN (${msgIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        )
        .all(...msgIds)
    : [];
  const artifacts = db
    .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY id ASC')
    .all(req.params.id);
  const atts = msgIds.length
    ? db
        .prepare(
          `SELECT * FROM message_attachments WHERE message_id IN (${msgIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        )
        .all(...msgIds)
    : [];

  res.json({ session, messages, tool_uses: tools, artifacts, attachments: atts });
});

// Get artifacts for a session
router.get('/:id/artifacts', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const rows = db
    .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY id ASC')
    .all(req.params.id);
  res.json(rows);
});

// Bundle all artifacts (or an explicit selection) from one session into
// a streamed .zip archive. Local-path layout so the user can unzip the
// archive into a fresh project and get the full set of files emitted
// by the chat — no roundtrip through the chat UI required.
//
// Usage:
//   GET /api/sessions/:id/artifacts.zip             — everything
//   GET /api/sessions/:id/artifacts.zip?ids=1,2,3   — only those
//
// The handler streams straight from SQLite → STORED zip entries →
// Express response. Memory footprint stays flat regardless of total
// payload size.
router.get('/:id/artifacts.zip', async (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });

  const requestedIds = (() => {
    if (typeof req.query.ids !== 'string' || !req.query.ids.trim()) return null;
    const out = [];
    for (const piece of req.query.ids.split(',')) {
      const n = Number(piece);
      if (Number.isInteger(n) && n > 0) out.push(n);
    }
    return out.length ? out : null;
  })();

  let rows;
  if (requestedIds) {
    const placeholders = requestedIds.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT id, title, type, language, content
           FROM artifacts
           WHERE session_id = ? AND id IN (${placeholders})
           ORDER BY id ASC`
      )
      .all(req.params.id, ...requestedIds);
  } else {
    rows = db
      .prepare(
        `SELECT id, title, type, language, content
           FROM artifacts
           WHERE session_id = ?
           ORDER BY id ASC`
      )
      .all(req.params.id);
  }

  if (rows.length === 0) {
    return res.status(404).json({ error: 'no artifacts in this session' });
  }

  // Deterministic filename + content-disposition. The slug uses the
  // session title (truncated, sanitized) so a download of session 5
  // and session 12 don't collide in the user's Downloads folder.
  const sessRow = db
    .prepare('SELECT title FROM sessions WHERE id = ?')
    .get(req.params.id);
  const titleSlug = (sessRow?.title || `session-${req.params.id}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `session-${req.params.id}`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="artifacts-${req.params.id}-${titleSlug}.zip"`
  );

  const zip = new ZipWriter(res);
  // Track in-zip basenames we've already seen so two artifacts with
  // the same title still both make it into the archive (the second
  // gets a `-2`, `-3`, ... suffix). Titles render the source's intent
  // for the user; the numeric id stays a fallback if the title is
  // empty.
  const usedNames = new Map();
  function uniqueName(base) {
    const cleanBase = (base || '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'artifact';
    const n = (usedNames.get(cleanBase) || 0) + 1;
    usedNames.set(cleanBase, n);
    return n === 1 ? cleanBase : `${cleanBase.replace(/(\.[^.]+)?$/, '')}-${n}$1`;
  }

  zip.on('error', (err) => {
    // Headers are already flushed; the only thing left to do is close
    // the connection so the client gets a truncated archive instead
    // of hanging forever.
    try { res.destroy(err); } catch { /* ignore */ }
  });

  zip.on('finish', () => { /* ok — ZipWriter calls out.end() in _final */ });

  try {
    for (const row of rows) {
      const isRenderable =
        row.type === 'html' || row.type === 'react' || row.type === 'jsx' ||
        row.type === 'svg' || row.type === 'markdown' || row.type === 'code';
      const base = row.title || (isRenderable ? `artifact-${row.id}.${row.type}` : `artifact-${row.id}`);
      const filename = uniqueName(base);
      // Add a directory prefix inside the archive so multiple-session
      // unzips don't smear into each other when concatenated.
      const archivePath = `${req.params.id}/${filename}`;
      await zip.addFile(archivePath, Buffer.from(row.content || '', 'utf8'));
    }
    zip.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'failed to build archive' });
    } else {
      try { res.destroy(err); } catch { /* ignore */ }
    }
  }
});

// Set feedback on an assistant message (like / dislike / clear).
// `value` accepts 'like', 'dislike', or null to clear. The route enforces
// ownership via session lookup and rejects feedback on non-assistant rows.
router.post('/:id/messages/:msgId/feedback', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const { value } = req.body || {};
  if (value !== null && value !== 'like' && value !== 'dislike') {
    return res.status(400).json({ error: 'value must be like, dislike, or null' });
  }
  const msg = db
    .prepare('SELECT id, role FROM messages WHERE id = ? AND session_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  if (msg.role !== 'assistant') {
    return res.status(400).json({ error: 'feedback only allowed on assistant messages' });
  }
  db.prepare('UPDATE messages SET feedback = ? WHERE id = ?').run(value, msg.id);
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id);
  res.json(updated);
});

// Regenerate an assistant message: delete it (cascade removes tool_uses /
// artifacts / attachments) and return the last user prompt + the assistant
// message id that should be re-rendered. The actual Claude invocation goes
// through the existing socket `prompt` flow; this endpoint just prepares the
// session state so the frontend can resubmit the same prompt cleanly.
// Remove a failed turn (assistant message + the user prompt right
// before it). Used by the FE after a 4xx/5xx from the upstream LLM so
// the sidebar isn't polluted with empty error rows. The user message
// deletion also drops its message_attachments via FK cascade.
router.post('/:id/messages/:msgId/delete-turn', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const target = db
    .prepare('SELECT id, role FROM messages WHERE id = ? AND session_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!target) return res.status(404).json({ error: 'message not found' });

  // Walk back from the target to the most recent user message. Accept
  // any role for the target — callers may want to nuke an empty
  // assistant placeholder plus its user prompt even when the user
  // message was empty (image-only send).
  const userPrompt = db
    .prepare(
      `SELECT id FROM messages
         WHERE session_id = ? AND role = 'user' AND id < ?
         ORDER BY id DESC LIMIT 1`
    )
    .get(req.params.id, target.id);

  const deleted = [];
  if (userPrompt) {
    db.prepare('DELETE FROM messages WHERE id = ?').run(userPrompt.id);
    deleted.push(userPrompt.id);
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(target.id);
  deleted.push(target.id);
  // Drop any artifacts that referenced either row (no FK on
  // artifacts.message_id — see db/index.js), plus tool_uses on the
  // assistant row.
  db.prepare(
    `DELETE FROM tool_uses WHERE message_id IN (?, ?)`
  ).run(target.id, userPrompt?.id ?? -1);
  db.prepare(
    `DELETE FROM artifacts WHERE message_id IN (?, ?)`
  ).run(target.id, userPrompt?.id ?? -1);

  res.json({ ok: true, deletedIds: deleted });
});

router.post('/:id/messages/:msgId/regenerate', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const target = db
    .prepare('SELECT id, role FROM messages WHERE id = ? AND session_id = ?')
    .get(req.params.msgId, req.params.id);
  if (!target) return res.status(404).json({ error: 'message not found' });
  if (target.role !== 'assistant') {
    return res.status(400).json({ error: 'can only regenerate assistant messages' });
  }
  // Find the most recent user prompt that came strictly before this assistant
  // message. The frontend re-sends that prompt via the socket to regenerate.
  const userPrompt = db
    .prepare(
      `SELECT id, content FROM messages
         WHERE session_id = ? AND role = 'user' AND id < ?
         ORDER BY id DESC LIMIT 1`
    )
    .get(req.params.id, target.id);

  // Delete the assistant message and everything that depends on it (tool_uses,
  // artifacts linked to it, attachments on it). Foreign-key cascade handles
  // the children.
  db.prepare('DELETE FROM messages WHERE id = ?').run(target.id);

  // Also clear any artifacts that referenced this assistant message — without
  // the parent message row the FK would dangle even though SQLite tolerates
  // it, the artifact panel would render stale content.
  db.prepare('DELETE FROM artifacts WHERE message_id = ?').run(target.id);

  // Bump updated_at so the sidebar re-sorts this session to the top while
  // the new response streams in.
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), req.params.id);

  res.json({
    ok: true,
    userPromptId: userPrompt?.id ?? null,
    userPromptContent: userPrompt?.content ?? null,
  });
});

export default router;