import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// All routes require auth (mounted with requireAuth in server.js).
// Per-route admin gating below.

function safeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || null,
    role: u.role,
    disabled: !!u.disabled,
    created_at: u.created_at,
    updated_at: u.updated_at || null,
    last_login_at: u.last_login_at || null,
  };
}

// GET /api/users — admin only
router.get('/', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, username, display_name, role, disabled,
              created_at, updated_at, last_login_at
         FROM users
        ORDER BY id ASC`
    )
    .all();
  res.json(rows.map(safeUser));
});

// POST /api/users — admin only: create new user
router.post('/', requireAdmin, (req, res) => {
  const { username, password, role, display_name } = req.body || {};
  if (!username?.trim() || !password) {
    return res.status(400).json({ error: 'username & password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password too short (min 6 chars)' });
  }
  const safeRole = role === 'admin' ? 'admin' : 'member';
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (exists) return res.status(409).json({ error: 'username already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, ?, ?, ?)`
    )
    .run(username.trim(), hash, safeRole, display_name?.trim() || null);
  res.json(safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
});

// PATCH /api/users/:id — admin only: role/display_name/disabled
router.patch('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });

  const { role, display_name, disabled } = req.body || {};
  const fields = [];
  const params = [];

  if (role !== undefined) {
    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: 'role must be admin or member' });
    }
    // Don't allow demoting the last admin
    if (target.role === 'admin' && role !== 'admin') {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?`)
        .get(req.params.id).n;
      if (otherAdmins === 0) {
        return res.status(400).json({ error: 'cannot demote the last admin' });
      }
    }
    fields.push('role = ?'); params.push(role);
  }
  if (display_name !== undefined) {
    fields.push('display_name = ?'); params.push(display_name?.trim() || null);
  }
  if (disabled !== undefined) {
    // Don't allow disabling the last admin
    if (target.role === 'admin' && disabled) {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?`)
        .get(req.params.id).n;
      if (otherAdmins === 0) {
        return res.status(400).json({ error: 'cannot disable the last admin' });
      }
    }
    fields.push('disabled = ?'); params.push(disabled ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
});

// POST /api/users/:id/reset-password — admin or self
router.post('/:id/reset-password', (req, res) => {
  const isSelf = req.user.id === Number(req.params.id);
  if (!isSelf && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin required' });
  }
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'new_password too short (min 6 chars)' });
  }
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare(
    'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(hash, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/users/:id — admin only; can't delete self or users with data
router.delete('/:id', requireAdmin, (req, res) => {
  if (req.user.id === Number(req.params.id)) {
    return res.status(400).json({ error: 'cannot delete yourself' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const sessCount = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(req.params.id).n;
  const projCount = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').get(req.params.id).n;
  if (sessCount > 0 || projCount > 0) {
    return res.status(400).json({
      error: `user has ${sessCount} session(s) and ${projCount} project(s); archive/disable instead of deleting`,
    });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;