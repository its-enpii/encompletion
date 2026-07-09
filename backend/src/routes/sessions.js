import express from 'express';
import db from '../db/index.js';

const router = express.Router();

// Build SQL fragment + params that limit rows to those owned by user unless admin.
// Returns { sql: ' AND (s.user_id = ? OR ? = \'admin\')', params: [userId, role] }
function ownedOrAdmin(user, alias = 's') {
  return {
    sql: ` AND (${alias}.user_id = ? OR ? = 'admin')`,
    params: [user.id, user.role || 'member'],
  };
}

function ownSessionOr404(sessionId, user) {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE id = ?
          AND (user_id = ? OR ? = 'admin')`
    )
    .get(sessionId, user.id, user.role || 'member');
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

// Create a new session
router.post('/', (req, res) => {
  const { title, model, project_id, system_prompt } = req.body || {};
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
  const info = db
    .prepare(
      `INSERT INTO sessions (title, model, project_id, system_prompt, user_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      title?.trim() || null,
      model || process.env.DEFAULT_MODEL || 'workspace',
      project_id || null,
      system_prompt || null,
      req.user.id
    );
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid));
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

  const { title, project_id, system_prompt, archived, starred } = req.body || {};
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
  if (archived !== undefined) {
    fields.push('archived_at = ?');
    params.push(archived ? new Date().toISOString() : null);
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

// Toggle starred flag. Dedicated route so the sidebar can flip with one call
// without round-tripping the current value or PATCHing all session fields.
router.post('/:id/star', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const next = own.starred ? 0 : 1;
  db.prepare(
    `UPDATE sessions SET starred = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(next, req.params.id);
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

// Delete session
router.delete('/:id', (req, res) => {
  const own = ownSessionOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
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
  db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

  res.json({
    ok: true,
    userPromptId: userPrompt?.id ?? null,
    userPromptContent: userPrompt?.content ?? null,
  });
});

export default router;