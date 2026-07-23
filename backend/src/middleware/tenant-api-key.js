/**
 * requireTenantApiKey — server-to-server auth for tenant integrations.
 *
 * Distinct from requireApiKey (per-user OpenAPI) because tenant_api_keys
 * resolve to a *tenant*, not a user. Used only by POST /api/embed/token
 * where a Laravel/saas-app backend swaps its long-lived tenant_api_key
 * for a short-lived embed_token.
 *
 * Attach on success: req.tenant = { id, slug, name, status, default_model_id, persona_config }.
 */

import crypto from 'node:crypto';
import db from '../db/index.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function hashKey(k) {
  return crypto.createHash('sha256').update(k).digest('hex');
}

function lookupKey(plaintext) {
  const h = hashKey(plaintext);
  return db
    .prepare(
      `SELECT k.id, k.tenant_id, k.revoked_at,
              t.id AS t_id, t.slug AS t_slug, t.name AS t_name,
              t.status AS t_status, t.default_model_id AS t_default_model_id,
              t.persona_config AS t_persona_config
         FROM tenant_api_keys k
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_hash = ?`
    )
    .get(h);
}

function readKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

export { readKey };

export function requireTenantApiKey(req, res, next) {
  const plaintext = readKey(req);
  if (!plaintext) return res.status(401).json({ error: 'missing tenant api key' });

  const h = hashKey(plaintext);
  const now = Date.now();
  const cached = cache.get(h);
  if (cached && cached.expiresAt > now) {
    if (cached.row.revoked_at) return res.status(401).json({ error: 'tenant api key revoked' });
    attach(req, cached.row);
    return next();
  }

  const row = lookupKey(plaintext);
  if (!row) return res.status(401).json({ error: 'invalid tenant api key' });
  if (row.revoked_at) return res.status(401).json({ error: 'tenant api key revoked' });
  if (row.t_status !== 'active') return res.status(403).json({ error: 'tenant not active' });

  cache.set(h, { row, expiresAt: now + CACHE_TTL_MS });
  attach(req, row);
  next();
}

function attach(req, row) {
  let persona = null;
  if (row.t_persona_config) {
    try {
      const parsed = JSON.parse(row.t_persona_config);
      if (parsed && typeof parsed === 'object') persona = parsed;
    } catch { /* ignore */ }
  }
  req.tenant = {
    api_key_id: row.id,
    id: row.t_id,
    slug: row.t_slug,
    name: row.t_name,
    status: row.t_status,
    default_model_id: row.t_default_model_id,
    persona_config: persona,
  };
}

export function _resetCacheForTests() {
  cache.clear();
}

export const _invalidateAllForTests = _resetCacheForTests;

/**
 * Drop a single cached row by key hash. Used when an admin revokes
 * a tenant API key so a request that just succeeded doesn't keep
 * returning the (now stale) row from cache for up to CACHE_TTL_MS.
 */
export function _invalidateCachedKey(plaintext) {
  const h = hashKey(plaintext);
  cache.delete(h);
}