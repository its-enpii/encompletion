import express from 'express';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function safeRole(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    is_system: !!row.is_system,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at || null,
    user_count: typeof row.user_count === 'number' ? row.user_count : 0,
  };
}

// GET /api/roles — admin. List roles + user counts.
router.get('/', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.label, r.is_system, r.sort_order, r.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.role = r.id) AS user_count
         FROM roles r
         ORDER BY r.sort_order ASC, r.id ASC`
    )
    .all();
  res.json({ roles: rows.map(safeRole) });
});

// POST /api/roles — admin. Create custom role.
// Body: { id: slug, label?: string }
router.post('/', requireAdmin, (req, res) => {
  const rawId = typeof req.body?.id === 'string' ? req.body.id.trim().toLowerCase() : '';
  if (!SLUG_RE.test(rawId)) {
    return res.status(400).json({
      error: 'id must be 1–32 chars: start with a–z, then a–z 0–9 _ -',
    });
  }
  if (rawId === 'admin') {
    return res.status(400).json({ error: 'admin role is reserved' });
  }
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const label = labelRaw || rawId;
  if (label.length > 64) {
    return res.status(400).json({ error: 'label too long (max 64)' });
  }
  const exists = db.prepare('SELECT id FROM roles WHERE id = ?').get(rawId);
  if (exists) return res.status(409).json({ error: 'role already exists' });

  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM roles').get().n;
  db.prepare(
    `INSERT INTO roles (id, label, is_system, sort_order) VALUES (?, ?, 0, ?)`
  ).run(rawId, label, maxSort + 1);

  res.status(201).json(
    safeRole(
      db
        .prepare(
          `SELECT r.*, 0 AS user_count FROM roles r WHERE r.id = ?`
        )
        .get(rawId)
    )
  );
});

// PATCH /api/roles/:id — admin. Rename label only (slug immutable).
router.patch('/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'role not found' });

  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : null;
  if (labelRaw == null) return res.status(400).json({ error: 'label required' });
  if (!labelRaw || labelRaw.length > 64) {
    return res.status(400).json({ error: 'label must be 1–64 chars' });
  }
  db.prepare('UPDATE roles SET label = ? WHERE id = ?').run(labelRaw, id);
  const user_count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(id).n;
  res.json(safeRole({ ...db.prepare('SELECT * FROM roles WHERE id = ?').get(id), user_count }));
});

// DELETE /api/roles/:id — admin. System roles blocked; reassign users first.
router.delete('/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').trim();
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'role not found' });
  if (row.is_system) {
    return res.status(400).json({ error: 'cannot delete system role' });
  }
  const users = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(id).n;
  if (users > 0) {
    return res.status(400).json({
      error: `role still assigned to ${users} user(s); reassign them first`,
    });
  }
  db.prepare('DELETE FROM role_models WHERE role = ?').run(id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  res.json({ ok: true, id });
});

export default router;
