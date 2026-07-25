/**
 * requireApiKey — Bearer-token (or ?key=) middleware backed by the
 * api_keys table. Computes sha256(key) and looks up the row.
 *
 * On success: req.user = { id, username, role, display_name }
 *            req.apiKey = { id, name, model }
 *
 * Caches successful lookups for 60s in-process so SSE polls don't hit
 * the DB on every tick. Cache key includes the key hash, so two
 * different keys don't collide.
 */

import crypto from 'node:crypto';
import db from '../db/index.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function hashKey(k) {
  return crypto.createHash('sha256').update(k).digest('hex');
}

function readKeyFromRequest(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.query.key) return String(req.query.key);
  if (req.query.token) return String(req.query.token);
  return null;
}

function lookupKey(plaintext) {
  const hash = hashKey(plaintext);
  const row = db
    .prepare(
      `SELECT k.id, k.user_id, k.name, k.model, k.created_at, k.last_used_at,
              u.username, u.role, u.display_name, u.disabled
         FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.key_hash = ?`
    )
    .get(hash);
  if (!row) return null;
  if (row.disabled) return null;
  return row;
}

export function requireApiKey(req, res, next) {
  const plaintext = readKeyFromRequest(req);
  if (!plaintext) return res.status(401).json({ error: 'missing api key' });

  const hash = hashKey(plaintext);
  const now = Date.now();
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > now) {
    attachToRequest(req, cached.row);
    return next();
  }

  const row = lookupKey(plaintext);
  if (!row) return res.status(401).json({ error: 'invalid api key' });

  cache.set(hash, { row, expiresAt: now + CACHE_TTL_MS });
  attachToRequest(req, row);

  // Best-effort: stamp last_used_at. SQLite writes are sync so we do
  // this without awaiting — a stale "last used" by <1s is fine.
  try {
    db.prepare(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  } catch { /* ignore */ }

  next();
}

function attachToRequest(req, row) {
  req.user = {
    id: row.user_id,
    username: row.username,
    role: row.role,
    display_name: row.display_name || null,
  };
  req.apiKey = {
    id: row.id,
    name: row.name,
    model: row.model,
  };
}

export function _resetCacheForTests() {
  cache.clear();
}
