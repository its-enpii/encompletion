import express from 'express';
import db from '../db/index.js';
import rag from '../rag.js';
import {
  listProjectFacts,
  upsertProjectFact,
  deleteProjectFact,
} from '../project_memory.js';

const router = express.Router();

function ownProjectOr404(id, user) {
  return db
    .prepare(
      `SELECT * FROM projects
        WHERE id = ?
          AND (owner_type = 'user' AND owner_id = ? OR ? = 'admin')`
    )
    .get(id, String(user.id), user.role || 'member');
}

// List projects (optionally include archived). Admin sees all; members see own only.
router.get('/', (req, res) => {
  const { include_archived } = req.query;
  const where = [];
  const params = [];
  where.push(`(p.owner_type = 'user' AND p.owner_id = ? OR ? = 'admin')`);
  params.push(String(req.user.id), req.user.role || 'member');
  if (!include_archived) where.push('p.archived_at IS NULL');
  const sql = `
    SELECT p.*,
           u.username AS owner_username,
           (SELECT COUNT(*) FROM sessions s
              WHERE s.project_id = p.id AND s.archived_at IS NULL) AS session_count
      FROM projects p
      LEFT JOIN users u ON u.id = p.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.updated_at DESC
  `;
  res.json(db.prepare(sql).all(...params));
});

// Create project
router.post('/', (req, res) => {
  const { name, description, instructions, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const info = db
    .prepare(
      `INSERT INTO projects (user_id, name, description, instructions, color, owner_type, owner_id)
       VALUES (?, ?, ?, ?, ?, 'user', ?)`
    )
    .run(
      req.user.id,
      name.trim(),
      description || null,
      instructions || null,
      color || '#3D348B',
      String(req.user.id)
    );
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});

// Get project + knowledge
router.get('/:id', (req, res) => {
  const project = ownProjectOr404(req.params.id, req.user);
  if (!project) return res.status(404).json({ error: 'not found' });
  const knowledge = db
    .prepare('SELECT * FROM project_knowledge WHERE project_id = ? ORDER BY id ASC')
    .all(req.params.id);
  const sessions = db
    .prepare(
      'SELECT * FROM sessions WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC'
    )
    .all(req.params.id);
  // Parse the JSON-encoded skill opt-out list once so the UI can
  // render it without having to do JSON.parse itself. Fallback to
  // [] on any corruption — a malformed cell should not break the
  // config page.
  if (project) {
    try {
      project.disabled_skills = JSON.parse(project.disabled_skills || '[]');
    } catch { project.disabled_skills = []; }
  }
  res.json({ project, knowledge, sessions });
});

// Update project
router.patch('/:id', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });

  const { name, description, instructions, color, archived, disabled_skills } = req.body || {};
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (instructions !== undefined) { fields.push('instructions = ?'); params.push(instructions); }
  if (color !== undefined) { fields.push('color = ?'); params.push(color); }
  if (archived !== undefined) {
    fields.push('archived_at = ?');
    params.push(archived ? new Date().toISOString() : null);
  }
  if (disabled_skills !== undefined) {
    // Array of skill names. Coerce + bound length so a malformed
    // request body can't blow up the column. Stored as JSON text.
    if (!Array.isArray(disabled_skills)) return res.status(400).json({ error: 'disabled_skills must be an array' });
    const names = disabled_skills
      .filter((n) => typeof n === 'string')
      .map((n) => n.slice(0, 100))
      .slice(0, 256);
    fields.push('disabled_skills = ?');
    params.push(JSON.stringify(names));
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id));
});

// Delete project (sessions.project_id -> NULL via FK)
router.delete('/:id', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  // Knowledge rows cascade-delete, but their embeddings_chunk rows
  // don't have FK back to projects — wipe by source_kind+source_id.
  const kids = db
    .prepare(`SELECT id FROM project_knowledge WHERE project_id = ?`)
    .all(req.params.id);
  for (const k of kids) rag.removeSource('project_knowledge', k.id);
  res.json({ ok: true });
});

// Knowledge CRUD
router.post('/:id/knowledge', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });

  const { title, type, content, file_path, file_name, mime_type, size } = req.body || {};
  if (!title?.trim() || !type) return res.status(400).json({ error: 'title & type required' });
  const info = db
    .prepare(
      `INSERT INTO project_knowledge
         (project_id, title, type, content, file_path, file_name, mime_type, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.params.id, title, type, content || null, file_path || null, file_name || null, mime_type || null, size || null);
  const row = db.prepare('SELECT * FROM project_knowledge WHERE id = ?').get(info.lastInsertRowid);
  // Index for RAG — text-only. File-type knowledge gets the
  // [Project Knowledge] prefix block in buildFinalPrompt; we don't
  // try to embed binaries.
  if (type === 'text' && typeof content === 'string' && content.trim().length > 0) {
    rag
      .indexSource({
        kind: 'project_knowledge',
        id: info.lastInsertRowid,
        content: `${title}\n\n${content}`,
      })
      .catch((e) => process.stderr.write(`[projects] rag index failed: ${e.message}\n`));
  }
  res.json(row);
});

router.delete('/:id/knowledge/:kid', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM project_knowledge WHERE id = ? AND project_id = ?').run(req.params.kid, req.params.id);
  rag.removeSource('project_knowledge', Number(req.params.kid));
  res.json({ ok: true });
});

// Project memory facts (Phase 5) — key/value facts scoped to this
// project, auto-injected into the system prompt for every chat whose
// session belongs here. Mirrors /api/memory/facts shape but nested
// under /api/projects/:id. ownProjectOr404 handles admin and per-user
// access; FK ON DELETE CASCADE on project_id handles fact cleanup
// when a project is deleted.
const MAX_FACT_KEY_LEN = 40;

router.get('/:id/facts', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  res.json({ facts: listProjectFacts(Number(req.params.id)) });
});

router.put('/:id/facts/:key', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  // URL key is the user-visible fact name (e.g. "stack"). The upsert
  // helper validates the regex so a single bad char → 400 here.
  const key = String(req.params.key || '').slice(0, MAX_FACT_KEY_LEN);
  const { value } = req.body || {};
  try {
    const row = upsertProjectFact(Number(req.params.id), key, value);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/facts/:fid', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  const id = Number(req.params.fid);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ok = deleteProjectFact(Number(req.params.id), id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

export default router;