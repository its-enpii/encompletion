import express from 'express';
import db from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { allowedModelKeysForRole, listRoleIds, roleExists } from '../model-access.js';

const router = express.Router();

// All routes require auth (mounted with requireAuth in server.js).
// GET is open to any authenticated user (their dropdown reads it).
// Mutations are admin-only.

// Validate the model key. The key is what we pass verbatim to the CLI
// (e.g. `--model <key>`), and it is persisted into historical session
// rows — so we don't auto-rewrite user input. The field is admin-only,
// so the operator knows what shape their engine expects. We only block
// patterns that would break shell parsing or the registration:
//   - empty (after trim)
//   - any internal whitespace or newlines
//
// Otherwise: dots, slashes, colons, backslashes, dashes, underscores, even
// quote chars are left to the operator. Server-side check mirrors the
// frontend so the same key is accepted everywhere.
function normalizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.trim();
  if (!k) return null;
  if (/\s/.test(k)) return null;
  if (k.length > 200) return null;
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
// dropdown, filtered by role_models grants. Admin + ?all=1 sees full
// registry (disabled included) for the management UI.
router.get('/', (req, res) => {
  const showAll = req.query.all === '1' && req.user.role === 'admin';
  if (showAll) {
    const rows = db
      .prepare('SELECT * FROM models ORDER BY sort_order ASC, id ASC')
      .all();
    return res.json(rows.map(safeRow));
  }
  const allowed = new Set(allowedModelKeysForRole(req.user.role));
  const rows = db
    .prepare(
      'SELECT * FROM models WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'
    )
    .all()
    .filter((row) => allowed.has(row.key));
  res.json(rows.map(safeEnabled));
});

// GET /api/models/role-access — admin. Full grant map for RBAC UI.
router.get('/role-access', requireAdmin, (_req, res) => {
  const roleIds = listRoleIds();
  const rows = db.prepare('SELECT role, model_key FROM role_models ORDER BY role, model_key').all();
  const byRole = Object.fromEntries(roleIds.map((id) => [id, []]));
  for (const row of rows) {
    if (byRole[row.role]) byRole[row.role].push(row.model_key);
  }
  res.json({
    roles: roleIds,
    grants: byRole,
    // Empty array = unrestricted for that role.
    note: 'Empty grants for a role means all enabled models are allowed.',
  });
});

// PUT /api/models/role-access — admin. Replace grants for one role.
// Body: { role: string, model_keys: string[] }
// Empty model_keys → unrestricted for that role.
router.put('/role-access', requireAdmin, (req, res) => {
  const roleRaw = typeof req.body?.role === 'string' ? req.body.role.trim() : '';
  if (!roleRaw || !roleExists(roleRaw)) {
    return res.status(400).json({ error: 'unknown role' });
  }
  const role = roleRaw;
  const raw = Array.isArray(req.body?.model_keys) ? req.body.model_keys : null;
  if (!raw) return res.status(400).json({ error: 'model_keys must be an array' });

  const keys = [];
  const seen = new Set();
  for (const item of raw) {
    const k = normalizeKey(typeof item === 'string' ? item : '');
    if (!k || seen.has(k)) continue;
    // Only accept keys that exist in registry (enabled or not — admin
    // may pre-grant a disabled model before re-enabling).
    const exists = db.prepare('SELECT id FROM models WHERE key = ?').get(k);
    if (!exists) continue;
    seen.add(k);
    keys.push(k);
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM role_models WHERE role = ?').run(role);
    const ins = db.prepare('INSERT INTO role_models (role, model_key) VALUES (?, ?)');
    for (const k of keys) ins.run(role, k);
  });
  tx();

  res.json({
    role,
    model_keys: keys,
    unrestricted: keys.length === 0,
  });
});

// POST /api/models/import — admin. Pull OpenAI-compatible GET /models
// from LLM_BASE_URL and upsert into the local registry.
// Body optional: { enable_new?: boolean } default true for new keys only.
router.post('/import', requireAdmin, async (req, res) => {
  const baseUrl = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return res.status(400).json({ error: 'LLM_BASE_URL is not configured' });
  }
  const apiKey = process.env.LLM_API_KEY || '';
  const enableNew = req.body?.enable_new === false ? false : true;
  const url = `${baseUrl}/models`;

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let r;
    try {
      r = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(502).json({
        error: `upstream models HTTP ${r.status}`,
        detail: body.slice(0, 300),
      });
    }
    data = await r.json();
  } catch (e) {
    return res.status(502).json({
      error: e?.name === 'AbortError' ? 'upstream models timeout' : (e?.message || String(e)),
    });
  }

  // OpenAI shape: { data: [ { id, ... } ] }. Also accept bare array.
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : Array.isArray(data?.models)
        ? data.models
        : [];

  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM models').get().n;
  let nextSort = maxSort + 10;
  const insert = db.prepare(
    `INSERT INTO models (key, label, enabled, sort_order) VALUES (?, ?, ?, ?)`
  );
  const existsStmt = db.prepare('SELECT id, enabled FROM models WHERE key = ?');

  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const addedKeys = [];

  const tx = db.transaction(() => {
    for (const item of list) {
      const rawId = item?.id ?? item?.name ?? item?.model ?? item?.key;
      const key = normalizeKey(typeof rawId === 'string' ? rawId : String(rawId || ''));
      if (!key) { invalid++; continue; }
      if (existsStmt.get(key)) { skipped++; continue; }
      // Label: last path segment or full key, capped 64.
      const labelRaw = (item?.name && typeof item.name === 'string' && item.name !== key)
        ? item.name
        : (key.includes('/') ? key.split('/').pop() : key);
      const label = normalizeLabel(String(labelRaw).slice(0, 64)) || key.slice(0, 64);
      insert.run(key, label, enableNew ? 1 : 0, nextSort);
      nextSort += 10;
      added++;
      addedKeys.push(key);
    }
  });
  tx();

  res.json({
    ok: true,
    source: url,
    upstream_count: list.length,
    added,
    skipped_existing: skipped,
    invalid,
    added_keys: addedKeys,
  });
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
  res.json({ ok: true, soft_deleted: true });
});

export default router;
