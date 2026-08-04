import express from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { decryptSecret } from '../crypto-secrets.js';

/**
 * Per-user model registry.
 *
 * Every authenticated user maintains their own list of models
 * imported from their own provider endpoint. The previous admin-
 * curated global `models` table is dormant (kept in db/index.js for
 * historical FK compatibility but never written to or read here).
 *
 * Endpoints (all under requireAuth, mounted in server.js):
 *   GET    /api/models           — caller's enabled list, for dropdown
 *   GET    /api/models?all=1     — caller's full list incl. disabled (UI mgmt)
 *   POST   /api/models/import    — fetches <user's base_url>/models, upserts
 *   POST   /api/models           — manual create
 *   PATCH  /api/models/:id       — edit label/enabled/sort_order/key
 *   DELETE /api/models/:id       — soft delete (enabled = 0)
 *
 * The `role_models` / RBAC machinery from the previous global-registry
 * design has been dropped — every user manages their own list, no
 * per-role gates.
 */

const router = express.Router();
router.use(requireAuth);

// ---- validation helpers (mirror the existing semantics) -----------

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
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    sort_order: row.sort_order,
  };
}

// ---- list / read ---------------------------------------------------

// GET /api/models — caller's enabled list, dropdown read.
// GET /api/models?all=1 — caller's full list incl. disabled, mgmt UI.
router.get('/', (req, res) => {
  const showAll = req.query.all === '1';
  const sql = showAll
    ? 'SELECT * FROM user_models WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
    : 'SELECT * FROM user_models WHERE user_id = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC';
  const rows = db.prepare(sql).all(req.user.id);
  res.json(showAll ? rows.map(safeRow) : rows.map(safeEnabled));
});

// ---- import -------------------------------------------------------

/**
 * POST /api/models/import — fetch <base_url>/models using the caller's
 * saved credentials, upsert into user_models. The body may also
 * override base_url / api_key for "preview" imports (rare).
 *
 * Body (all optional):
 *   { enable_new?: boolean, base_url?: string, api_key?: string }
 */
router.post('/import', async (req, res) => {
  const stored = db
    .prepare('SELECT base_url, api_key_blob FROM user_llm_settings WHERE user_id = ?')
    .get(req.user.id);

  // Resolve base_url + api_key. Inline override wins so the user can
  // test a different endpoint without saving first.
  let baseUrl = typeof req.body?.base_url === 'string'
    ? req.body.base_url.trim().replace(/\/+$/, '')
    : '';
  let apiKey = typeof req.body?.api_key === 'string'
    ? req.body.api_key.trim()
    : '';

  if (!baseUrl && stored?.base_url) baseUrl = stored.base_url.replace(/\/+$/, '');
  if (!apiKey && stored?.api_key_blob) {
    try {
      apiKey = decryptSecret(stored.api_key_blob);
    } catch (e) {
      return res.status(400).json({ error: `stored api_key is unreadable: ${e?.message || e}` });
    }
  }
  if (!baseUrl) {
    return res.status(400).json({ error: 'base_url is not configured — save AI Settings first' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: 'api_key is not configured — save AI Settings first' });
  }

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
          Authorization: `Bearer ${apiKey}`,
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
      error: e?.name === 'AbortError'
        ? 'upstream models timeout'
        : (e?.message || String(e)),
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

  const maxSort = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM user_models WHERE user_id = ?')
    .get(req.user.id).n;
  let nextSort = maxSort + 10;
  const insert = db.prepare(
    `INSERT INTO user_models (user_id, key, label, enabled, sort_order) VALUES (?, ?, ?, ?, ?)`
  );
  const existsStmt = db.prepare(
    'SELECT id, enabled FROM user_models WHERE user_id = ? AND key = ?'
  );

  let added = 0;
  let skipped = 0;
  let invalid = 0;
  const addedKeys = [];

  const tx = db.transaction(() => {
    for (const item of list) {
      const rawId = item?.id ?? item?.name ?? item?.model ?? item?.key;
      const key = normalizeKey(typeof rawId === 'string' ? rawId : String(rawId || ''));
      if (!key) { invalid++; continue; }
      if (existsStmt.get(req.user.id, key)) { skipped++; continue; }
      const labelRaw = (item?.name && typeof item.name === 'string' && item.name !== key)
        ? item.name
        : (key.includes('/') ? key.split('/').pop() : key);
      const label = normalizeLabel(String(labelRaw).slice(0, 64)) || key.slice(0, 64);
      insert.run(req.user.id, key, label, enableNew ? 1 : 0, nextSort);
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

// ---- CRUD (scoped to caller) --------------------------------------

router.post('/', (req, res) => {
  const key = normalizeKey(req.body?.key);
  const label = normalizeLabel(req.body?.label);
  const enabled = req.body?.enabled === false ? 0 : 1;
  const sort_order = Number.isFinite(req.body?.sort_order)
    ? Math.max(0, Math.min(10000, Math.trunc(req.body.sort_order)))
    : 0;

  if (!key) return res.status(400).json({ error: 'key must be 1-200 chars, no whitespace' });
  if (!label) return res.status(400).json({ error: 'label required (1-64 chars)' });

  const exists = db.prepare(
    'SELECT id FROM user_models WHERE user_id = ? AND key = ?'
  ).get(req.user.id, key);
  if (exists) return res.status(409).json({ error: 'key already exists' });

  const info = db
    .prepare(
      `INSERT INTO user_models (user_id, key, label, enabled, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(req.user.id, key, label, enabled, sort_order);
  const row = db.prepare('SELECT * FROM user_models WHERE id = ?').get(info.lastInsertRowid);
  res.json(safeRow(row));
});

router.patch('/:id', (req, res) => {
  const target = db
    .prepare('SELECT * FROM user_models WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!target) return res.status(404).json({ error: 'model not found' });

  const fields = [];
  const params = [];

  if (req.body?.label !== undefined) {
    const label = normalizeLabel(req.body.label);
    if (!label) return res.status(400).json({ error: 'label must be 1-64 chars' });
    fields.push('label = ?'); params.push(label);
  }

  if (req.body?.enabled !== undefined) {
    if (req.body.enabled === false) {
      const enabledCount = db
        .prepare('SELECT COUNT(*) AS n FROM user_models WHERE user_id = ? AND enabled = 1 AND id != ?')
        .get(req.user.id, req.params.id).n;
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

  if (req.body?.key !== undefined) {
    const key = normalizeKey(req.body.key);
    if (!key) return res.status(400).json({ error: 'key must be 1-200 chars, no whitespace' });
    if (key !== target.key) {
      const exists = db.prepare(
        'SELECT id FROM user_models WHERE user_id = ? AND key = ? AND id != ?'
      ).get(req.user.id, key, req.params.id);
      if (exists) return res.status(409).json({ error: 'key already in use' });
      fields.push('key = ?'); params.push(key);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE user_models SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(safeRow(db.prepare('SELECT * FROM user_models WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  const target = db
    .prepare('SELECT * FROM user_models WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!target) return res.status(404).json({ error: 'model not found' });

  const enabledCount = db
    .prepare('SELECT COUNT(*) AS n FROM user_models WHERE user_id = ? AND enabled = 1 AND id != ?')
    .get(req.user.id, req.params.id).n;
  if (target.enabled === 1 && enabledCount === 0) {
    return res.status(400).json({ error: 'cannot disable the last enabled model' });
  }

  db.prepare(
    'UPDATE user_models SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(req.params.id);
  res.json({ ok: true, soft_deleted: true });
});

export default router;