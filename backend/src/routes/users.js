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

// GET /api/users — admin only. Paginated.
// Query params:
//   limit  — 1..500, default 50
//   offset — >=0, default 0
//   q      — case-insensitive search on username + display_name
//   sort   — one of: id | username | role | created_at | last_login_at
//   dir    — 'asc' | 'desc', default asc
//
// Response: { users, total, limit, offset }
//   total — total rows matching the WHERE (not just the page slice),
//           so the FE can render "Showing X–Y of N" + page counts
//           without a second roundtrip.
const SORT_COLS = { id: 'id', username: 'username', role: 'role', created_at: 'created_at', last_login_at: 'last_login_at' };
router.get('/', requireAdmin, (req, res) => {
  // Limit: missing/non-numeric/non-positive → 50. Upper-bounded at
  // 500. We use a single `parseInt(... || ...)` so `limit=0`,
  // `limit=-5`, and `limit=abc` all collapse to the default rather than
  // the floor — keeps pagination predictable for fat-fingered URLs.
  const rawLimit = parseInt(req.query.limit ?? '50', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 500)
    : 50;
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  const search = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const sortKey = SORT_COLS[String(req.query.sort || 'id')] || 'id';
  const sortDir = String(req.query.dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const where = [];
  const params = [];
  if (search) {
    // SQLite reads '' inside COALESCE as an empty quoted identifier,
    // not a string literal — wrap in single quotes for the column
    // default. (Empty string cast is fine for our purposes; the
    // search term rarely matches an empty display_name anyway.)
    where.push(`(LOWER(username) LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ?)`);
    const needle = `%${search}%`;
    params.push(needle, needle);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM users ${whereSql}`)
    .get(...params).n;

  const rows = db
    .prepare(
      `SELECT id, username, display_name, role, disabled,
              created_at, updated_at, last_login_at
         FROM users
         ${whereSql}
         ORDER BY ${sortKey} ${sortDir}
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  res.json({
    users: rows.map(safeUser),
    total,
    limit,
    offset,
  });
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