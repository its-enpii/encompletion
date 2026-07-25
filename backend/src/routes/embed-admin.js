/**
 * embed-admin — admin-only CRUD for tenant tools, capability profiles,
 * and audit log read access.
 *
 * Mounted at /api/admin/embed (see server.js). All routes require
 * requireAuth + requireAdmin. Tenant apps never call these — only
 * Encompletion operators managing a tenant from the dashboard.
 *
 * Tool records are keyed by tenant_id + name. Renaming a tool is
 * destructive (the LLM calls it by name); clients should delete + add
 * instead. The endpoint_url is the saas-app endpoint the executor
 * POSTs to; the operator is responsible for putting a stable,
 * authenticated endpoint there.
 */

import express from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { readKey, _invalidateCachedKey, _resetCacheForTests } from '../middleware/tenant-api-key.js';
import { invalidatePersonaCache } from '../persona.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);

const MAX_TOOL_FIELDS = {
  name: 80,
  description: 4000,
  endpoint_url: 1024,
};

// -- Tenant CRUD (minimal — full management UI is out of scope for E3) -

router.get('/tenants', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, u.username AS created_by_username,
              (SELECT COUNT(*) FROM tools k WHERE k.tenant_id = t.id) AS tool_count
         FROM tenants t
         LEFT JOIN users u ON u.id = t.created_by
         ORDER BY t.created_at DESC`
    )
    .all();
  res.json(rows);
});

router.post('/tenants', (req, res) => {
  const { name, slug, status, default_model_id, persona_config } = req.body || {};
  if (!name?.trim() || !slug?.trim()) return res.status(400).json({ error: 'name and slug required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug must be kebab-case' });
  const id = 'tenant-' + crypto.randomBytes(8).toString('hex');
  try {
    db.prepare(
      `INSERT INTO tenants (id, name, slug, status, default_model_id, persona_config, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      name.trim(),
      slug.trim(),
      status || 'active',
      default_model_id || null,
      persona_config ? JSON.stringify(persona_config) : null,
      req.user.id
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'slug already in use' });
    throw e;
  }
  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  res.status(201).json(row);
});

router.patch('/tenants/:id', (req, res) => {
  const own = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!own) return res.status(404).json({ error: 'not found' });
  const { name, status, default_model_id, persona_config } = req.body || {};
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (status !== undefined) {
    if (!['active', 'suspended', 'trial'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    fields.push('status = ?'); params.push(status);
  }
  if (default_model_id !== undefined) { fields.push('default_model_id = ?'); params.push(default_model_id); }
  if (persona_config !== undefined) {
    fields.push('persona_config = ?');
    params.push(persona_config === null ? null : JSON.stringify(persona_config));
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  invalidatePersonaCache(req.params.id);
  res.json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id));
});

// -- Capability profile -

router.get('/tenants/:id/capability', (req, res) => {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const row = db.prepare('SELECT * FROM tenant_capability_profile WHERE tenant_id = ?').get(req.params.id);
  res.json(row || null);
});

router.put('/tenants/:id/capability', (req, res) => {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const {
    allow_artifact_generation = 1,
    allow_bash = 0,
    allowed_tool_ids = [],
    max_context_tokens = null,
    rate_limit_override = null,
  } = req.body || {};
  if (!Array.isArray(allowed_tool_ids)) return res.status(400).json({ error: 'allowed_tool_ids must be an array' });
  const tools = allowed_tool_ids.filter((s) => typeof s === 'string').slice(0, 256);
  // Validate rate_limit_override — null clears, integer > 0 sets, anything
  // else rejected so a malformed PUT can't quietly disable rate limiting.
  let rlOverride = null;
  if (rate_limit_override !== null && rate_limit_override !== undefined) {
    if (!Number.isInteger(rate_limit_override) || rate_limit_override <= 0 || rate_limit_override > 10000) {
      return res.status(400).json({ error: 'rate_limit_override must be a positive integer (≤10000) or null' });
    }
    rlOverride = rate_limit_override;
  }
  const exists = db.prepare('SELECT id FROM tenant_capability_profile WHERE tenant_id = ?').get(req.params.id);
  if (exists) {
    db.prepare(
      `UPDATE tenant_capability_profile
         SET allow_artifact_generation = ?, allow_bash = ?, allowed_tool_ids = ?,
             max_context_tokens = ?, rate_limit_override = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`
    ).run(allow_artifact_generation ? 1 : 0, allow_bash ? 1 : 0, JSON.stringify(tools), max_context_tokens, rlOverride, req.params.id);
  } else {
    db.prepare(
      `INSERT INTO tenant_capability_profile
         (id, tenant_id, allow_artifact_generation, allow_bash, allowed_tool_ids,
          max_context_tokens, rate_limit_override)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'cap-' + crypto.randomBytes(8).toString('hex'),
      req.params.id,
      allow_artifact_generation ? 1 : 0,
      allow_bash ? 1 : 0,
      JSON.stringify(tools),
      max_context_tokens,
      rlOverride
    );
  }
  res.json(db.prepare('SELECT * FROM tenant_capability_profile WHERE tenant_id = ?').get(req.params.id));
});

// -- Tools CRUD (Kategori B registry) -

router.get('/tenants/:id/tools', (req, res) => {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const rows = db.prepare('SELECT * FROM tools WHERE tenant_id = ? ORDER BY name ASC').all(req.params.id);
  res.json(rows);
});

router.post('/tenants/:id/tools', (req, res) => {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const { name, description, json_schema, endpoint_url, tool_category, requires_confirmation, is_active } = req.body || {};
  if (!name?.trim() || !description || !json_schema || !endpoint_url) {
    return res.status(400).json({ error: 'name, description, json_schema, endpoint_url required' });
  }
  // Best-effort URL parse — reject anything that doesn't look like an
  // http(s) URL. endpoint_url is admin-controlled, but we want a guard
  // rail against file://, javascript:, etc.
  try { new URL(endpoint_url); } catch { return res.status(400).json({ error: 'invalid endpoint_url' }); }
  if (!['business_action', 'content_generation'].includes(tool_category || 'business_action')) {
    return res.status(400).json({ error: 'invalid tool_category' });
  }
  let parsedSchema;
  try { parsedSchema = typeof json_schema === 'string' ? JSON.parse(json_schema) : json_schema; }
  catch { return res.status(400).json({ error: 'invalid json_schema' }); }
  const id = 'tool-' + crypto.randomBytes(8).toString('hex');
  try {
    db.prepare(
      `INSERT INTO tools
         (id, tenant_id, name, description, json_schema, endpoint_url,
          tool_category, requires_confirmation, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.id,
      String(name).trim().slice(0, MAX_TOOL_FIELDS.name),
      String(description).slice(0, MAX_TOOL_FIELDS.description),
      JSON.stringify(parsedSchema),
      String(endpoint_url).slice(0, MAX_TOOL_FIELDS.endpoint_url),
      tool_category || 'business_action',
      requires_confirmation ? 1 : 0,
      is_active === false ? 0 : 1
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'tool name already exists for this tenant' });
    throw e;
  }
  res.status(201).json(db.prepare('SELECT * FROM tools WHERE id = ?').get(id));
});

router.patch('/tools/:id', (req, res) => {
  const tool = db.prepare('SELECT id FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'not found' });
  const { description, json_schema, endpoint_url, tool_category, requires_confirmation, is_active } = req.body || {};
  const fields = [];
  const params = [];
  if (description !== undefined) {
    fields.push('description = ?');
    params.push(String(description).slice(0, MAX_TOOL_FIELDS.description));
  }
  if (json_schema !== undefined) {
    let parsed;
    try { parsed = typeof json_schema === 'string' ? JSON.parse(json_schema) : json_schema; }
    catch { return res.status(400).json({ error: 'invalid json_schema' }); }
    fields.push('json_schema = ?');
    params.push(JSON.stringify(parsed));
  }
  if (endpoint_url !== undefined) {
    try { new URL(endpoint_url); } catch { return res.status(400).json({ error: 'invalid endpoint_url' }); }
    fields.push('endpoint_url = ?');
    params.push(String(endpoint_url).slice(0, MAX_TOOL_FIELDS.endpoint_url));
  }
  if (tool_category !== undefined) {
    if (!['business_action', 'content_generation'].includes(tool_category)) return res.status(400).json({ error: 'invalid tool_category' });
    fields.push('tool_category = ?');
    params.push(tool_category);
  }
  if (requires_confirmation !== undefined) {
    fields.push('requires_confirmation = ?');
    params.push(requires_confirmation ? 1 : 0);
  }
  if (is_active !== undefined) {
    fields.push('is_active = ?');
    params.push(is_active ? 1 : 0);
  }
  if (!fields.length) return res.status(400).json({ error: 'no fields' });
  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE tools SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id));
});

router.delete('/tools/:id', (req, res) => {
  const tool = db.prepare('SELECT id FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// -- Tenant API key issuance ----------------------------------------------
//
// Server-to-server credential for the tenant's saas-app backend. Issued
// here so an admin onboarding a customer can hand over the plaintext
// (and the customer pastes it into their Laravel config). Plaintext
// is returned ONCE — we keep only sha256(hash) on disk.

router.post('/tenants/:id/api-keys', (req, res) => {
  const tenant = db
    .prepare(`SELECT id, status FROM tenants WHERE id = ?`)
    .get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  if (tenant.status !== 'active') {
    return res.status(400).json({ error: 'tenant not active' });
  }
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const safeName = name.trim().slice(0, 80);
  const plaintext = 'tk_' + crypto.randomBytes(24).toString('base64url');
  const keyHash = crypto
    .createHash('sha256')
    .update(plaintext)
    .digest('hex');
  const info = db
    .prepare(`INSERT INTO tenant_api_keys (tenant_id, name, key_hash) VALUES (?, ?, ?)`)
    .run(req.params.id, safeName, keyHash);
  res.status(201).json({
    id: info.lastInsertRowid,
    tenant_id: req.params.id,
    name: safeName,
    plaintext,
    // For display only — the saas-app gets the full plaintext.
    prefix: plaintext.slice(0, 12) + '…',
  });
});

// List a tenant's keys (read-only — never returns plaintext, only
// metadata + prefix is impossible without the hash, so we just show
// name + created + revoked_at).
router.get('/tenants/:id/api-keys', (req, res) => {
  const tenant = db
    .prepare(`SELECT id FROM tenants WHERE id = ?`)
    .get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const rows = db
    .prepare(
      `SELECT id, name, revoked_at, created_at
         FROM tenant_api_keys
        WHERE tenant_id = ?
        ORDER BY id DESC`
    )
    .all(req.params.id);
  res.json(rows);
});

router.post('/tenants/:id/api-keys/:keyId/revoke', (req, res) => {
  const tenant = db
    .prepare(`SELECT id FROM tenants WHERE id = ?`)
    .get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const r = db
    .prepare(
      `UPDATE tenant_api_keys
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`
    )
    .run(req.params.keyId, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'key not found or already revoked' });
  // Drop the cached lookup so a request issued before the revoke but
  // arriving within the 60s cache window can't keep using the now-
  // revoked key. Without this the test would have to wait for the
  // cache to age out, and a real attacker with a stolen key would
  // stay valid for up to 60s after the operator clicks "revoke".
  _invalidateCachedKey(req.body?.plaintext || '');
  // Also clear the in-memory lookup cache so other active keys don't
  // pay for the revoke — at most 60s of cache warmth loss per other
  // tenant key. The plaintext isn't in the revoke body so we can't
  // drop a single entry; full reset is the safe move.
  _resetCacheForTests();
  res.json({ ok: true });
});

// -- Audit log read -

router.get('/tenants/:id/executions', (req, res) => {
  const tenant = db.prepare('SELECT id FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const status = req.query.status;
  // Use `te.tenant_id` because tool_executions is the row we're
  // filtering on; the messages JOIN is optional (LEFT) and bare
  // `tenant_id` would be ambiguous when the planner walks both sides.
  const where = ['te.tenant_id = ?'];
  const params = [req.params.id];
  if (status) {
    where.push('te.status = ?');
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT te.*, t.name AS tool_name, m.content AS message_preview
         FROM tool_executions te
         LEFT JOIN tools t ON t.id = te.tool_id
         LEFT JOIN messages m ON m.id = te.message_id
        WHERE ${where.join(' AND ')}
        ORDER BY te.requested_at DESC
        LIMIT ${limit}`
    )
    .all(...params);
  res.json(rows);
});

// -- Analytics -------------------------------------------------------------

/**
 * Tenant-level aggregates for the dashboard. Counts are scoped to the
 * tenant via owner_type='tenant' + owner_id=tenant.id so cross-tenant
 * leakage is impossible from the SQL alone.
 *
 * `since` is optional — defaults to last 30 days. Daily buckets are
 * cheap to compute with SQLite's date() on the indexed created_at /
 * requested_at columns.
 */
router.get('/tenants/:id/analytics', (req, res) => {
  const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const since = (req.query.since && /^\d{4}-\d{2}-\d{2}/.test(req.query.since))
    ? req.query.since
    : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // Canonicalize the comparison so a date-only `since` matches both
  // space-format and ISO-format timestamps written by mixed code paths.
  const sinceTs = since + 'T00:00:00.000Z';

  // Totals — sessions, messages, runs, cost. Cost is summed from
  // sessions.total_cost_usd where the session is tenant-owned.
  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions
            WHERE owner_type = 'tenant' AND owner_id = ?) AS total_sessions,
         (SELECT COUNT(*) FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE s.owner_type = 'tenant' AND s.owner_id = ?
              AND datetime(m.created_at) >= datetime(?)) AS total_messages,
         (SELECT COUNT(*) FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE s.owner_type = 'tenant' AND s.owner_id = ?
              AND m.role = 'assistant'
              AND datetime(m.created_at) >= datetime(?)) AS total_assistant_messages,
         (SELECT COALESCE(SUM(total_cost_usd), 0) FROM sessions
            WHERE owner_type = 'tenant' AND owner_id = ?) AS total_cost_usd,
         (SELECT COALESCE(SUM(total_tokens), 0) FROM sessions
            WHERE owner_type = 'tenant' AND owner_id = ?) AS total_tokens`
    )
    .get(req.params.id, req.params.id, since, req.params.id, since, req.params.id, req.params.id);

  // Tool executions breakdown by status.
  const toolByStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM tool_executions
        WHERE tenant_id = ? AND datetime(requested_at) >= datetime(?)
        GROUP BY status`
    )
    .all(req.params.id, since);
  const toolCounts = { executed: 0, failed: 0, pending_confirmation: 0, rejected: 0, confirmed: 0 };
  for (const row of toolByStatus) toolCounts[row.status] = row.n;

  // Top tools by execution count.
  const topTools = db
    .prepare(
      `SELECT t.name AS tool_name, COUNT(*) AS n
         FROM tool_executions te
         LEFT JOIN tools t ON t.id = te.tool_id
        WHERE te.tenant_id = ? AND datetime(te.requested_at) >= datetime(?)
        GROUP BY te.tool_id
        ORDER BY n DESC
        LIMIT 10`
    )
    .all(req.params.id, since);

  // Daily buckets — messages per day for the sparkline.
  const daily = db
    .prepare(
      `SELECT date(m.created_at) AS day,
              COUNT(*) AS messages,
              SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) AS replies,
              COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN m.cost_usd ELSE 0 END), 0) AS cost_usd
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE s.owner_type = 'tenant' AND s.owner_id = ?
          AND datetime(m.created_at) >= datetime(?)
        GROUP BY day
        ORDER BY day ASC`
    )
    .all(req.params.id, since);

  res.json({
    tenant: { id: tenant.id, name: tenant.name },
    since,
    totals: {
      sessions: totals.total_sessions,
      messages: totals.total_messages,
      assistant_messages: totals.total_assistant_messages,
      total_cost_usd: totals.total_cost_usd,
      total_tokens: totals.total_tokens,
    },
    tools: {
      by_status: toolCounts,
      top: topTools,
    },
    daily,
  });
});

export default router;