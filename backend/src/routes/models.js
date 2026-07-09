import express from 'express';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Broadcast helper — emits `models:updated` with the current enabled list
// so chat headers elsewhere can re-fetch / refresh state. Best-effort: if
// `io` isn't mounted (e.g. during a startup race), skip silently.
function broadcast(io) {
  if (!io) return;
  try {
    const rows = db
      .prepare(
        'SELECT id, key, label, sort_order FROM models WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'
      )
      .all();
    io.emit('models:updated', { models: rows });
  } catch {
    /* swallow: broadcast is decorative */
  }
}

// All routes require auth (mounted with requireAuth in server.js).
// GET is open to any authenticated user (their dropdown reads it).
// Mutations are admin-only.

// Validate the model key. Same constraints as Claude CLI model ids:
// lowercase kebab-case (letters, digits, hyphens). 1-64 chars. No leading/
// trailing hyphens.
function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(k)) return null;
  return k;
}

function normalizeLabel(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 1 || t.length > 64) return null;
  return t;
}

function safeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    enabled: !!row.enabled,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

function safeEnabled(row) {
  // Same as safeRow but no enabled field — exposed to members reading the
  // dropdown list. We still withhold disabled rows so the UI just renders
  // what's selectable, not the full registry.
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    sort_order: row.sort_order,
  };
}

// GET /api/models — any auth user. Returns enabled models sorted for the
// dropdown. Admin views use the same endpoint plus pass ?all=1 to see
// disabled rows (the admin UI uses that to manage the registry).
router.get('/', (req, res) => {
  const showAll = req.query.all === '1' && req.user.role === 'admin';
  const rows = showAll
    ? db
        .prepare('SELECT * FROM models ORDER BY sort_order ASC, id ASC')
        .all()
    : db
        .prepare(
          'SELECT * FROM models WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'
        )
        .all();
  res.json(rows.map(showAll ? safeRow : safeEnabled));
});

// POST /api/models — admin only.
router.post('/', requireAdmin, (req, res) => {
  const key = normalizeKey(req.body?.key);
  const label = normalizeLabel(req.body?.label);
  const enabled = req.body?.enabled === false ? 0 : 1;
  const sort_order = Number.isFinite(req.body?.sort_order)
    ? Math.max(0, Math.min(10000, Math.trunc(req.body.sort_order)))
    : 0;

  if (!key) return res.status(400).json({ error: 'key must be lowercase kebab-case (1-64 chars)' });
  if (!label) return res.status(400).json({ error: 'label required (1-64 chars)' });

  const exists = db.prepare('SELECT id FROM models WHERE key = ?').get(key);
  if (exists) return res.status(409).json({ error: 'key already exists' });

  const info = db
    .prepare(
      `INSERT INTO models (key, label, enabled, sort_order)
       VALUES (?, ?, ?, ?)`
    )
    .run(key, label, enabled, sort_order);
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid);
  broadcast(req.app.get('io'));
  res.json(safeRow(row));
});

// PATCH /api/models/:id — admin only.
router.patch('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'model not found' });

  const fields = [];
  const params = [];

  if (req.body?.label !== undefined) {
    const label = normalizeLabel(req.body.label);
    if (!label) return res.status(400).json({ error: 'label must be 1-64 chars' });
    fields.push('label = ?'); params.push(label);
  }

  if (req.body?.enabled !== undefined) {
    // Don't allow disabling the last enabled model — the dropdown would be
    // empty and no chat could be started.
    if (req.body.enabled === false) {
      const enabledCount = db
        .prepare('SELECT COUNT(*) AS n FROM models WHERE enabled = 1 AND id != ?')
        .get(req.params.id).n;
      if (enabledCount === 0) {
        return res.status(400).json({ error: 'cannot disable the last enabled model' });
      }
    }
    fields.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0);
  }

  if (req.body?.sort_order !== undefined) {
    if (!Number.isFinite(req.body.sort_order)) {
      return res.status(400).json({ error: 'sort_order must be a number' });
    }
    const so = Math.max(0, Math.min(10000, Math.trunc(req.body.sort_order)));
    fields.push('sort_order = ?'); params.push(so);
  }

  // Key rename is rare; gate it behind explicit `key` field.
  if (req.body?.key !== undefined) {
    const key = normalizeKey(req.body.key);
    if (!key) return res.status(400).json({ error: 'key must be lowercase kebab-case' });
    if (key !== target.key) {
      const exists = db.prepare('SELECT id FROM models WHERE key = ? AND id != ?')
        .get(key, req.params.id);
      if (exists) return res.status(409).json({ error: 'key already in use' });
      // Rewriting the key does NOT touch sessions.model — historical data
      // keeps the old key. Admins should add a new model + disable the old
      // one instead of mutating keys when continuity matters.
      fields.push('key = ?'); params.push(key);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  broadcast(req.app.get('io'));
  res.json(safeRow(db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id)));
});

// DELETE /api/models/:id — admin only. Soft delete (enabled = 0) so the
// row stays around for sessions that already reference its key. A real
// DELETE is rejected: the "delete" in the admin UI is implemented as a
// soft delete, matching the privacy/transparency guarantees elsewhere.
router.delete('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'model not found' });

  // Refuse to disable the last enabled model.
  const enabledCount = db
    .prepare('SELECT COUNT(*) AS n FROM models WHERE enabled = 1 AND id != ?')
    .get(req.params.id).n;
  if (target.enabled === 1 && enabledCount === 0) {
    return res.status(400).json({ error: 'cannot disable the last enabled model' });
  }

  db.prepare(
    'UPDATE models SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(req.params.id);
  broadcast(req.app.get('io'));
  res.json({ ok: true, soft_deleted: true });
});

export default router;
