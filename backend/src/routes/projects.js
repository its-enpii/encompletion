import express from 'express';
import db from '../db/index.js';

const router = express.Router();

function ownProjectOr404(id, user) {
  return db
    .prepare(
      `SELECT * FROM projects
        WHERE id = ?
          AND (user_id = ? OR ? = 'admin')`
    )
    .get(id, user.id, user.role || 'member');
}

// List projects (optionally include archived). Admin sees all; members see own only.
router.get('/', (req, res) => {
  const { include_archived } = req.query;
  const where = [];
  const params = [];
  where.push('(p.user_id = ? OR ? = \'admin\')');
  params.push(req.user.id, req.user.role || 'member');
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
      `INSERT INTO projects (user_id, name, description, instructions, color)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      name.trim(),
      description || null,
      instructions || null,
      color || '#3D348B'
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
  res.json({ project, knowledge, sessions });
});

// Update project
router.patch('/:id', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });

  const { name, description, instructions, color, archived } = req.body || {};
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
  res.json(db.prepare('SELECT * FROM project_knowledge WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/:id/knowledge/:kid', (req, res) => {
  const own = ownProjectOr404(req.params.id, req.user);
  if (!own) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM project_knowledge WHERE id = ? AND project_id = ?').run(req.params.kid, req.params.id);
  res.json({ ok: true });
});

export default router;