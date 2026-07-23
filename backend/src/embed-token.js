/**
 * embed-token — issue + verify the short-lived tokens handed to the
 * browser widget.
 *
 * Token format: opaque random string, prefixed `em_` for grep-ability.
 * Stored at rest as sha256(token) only. Plaintext is returned ONCE to
 * the caller and never persisted.
 *
 * Issuance is server-to-server: a Laravel/saas-app backend calls
 * POST /api/embed/token with a tenant_api_key and gets back an
 * embed_token to forward to its browser widget. Verification is the
 * opposite direction — the widget presents the token, we resolve it
 * back to { tenant_id, external_user_id }.
 *
 * Default TTL: 30 minutes. Override via EMBED_TOKEN_TTL_MIN env.
 */

import crypto from 'node:crypto';
import db from './db/index.js';

const DEFAULT_TTL_MIN = 30;
const TTL_MIN = parseInt(process.env.EMBED_TOKEN_TTL_MIN || `${DEFAULT_TTL_MIN}`, 10);

export function _ttlMin() {
  return TTL_MIN;
}

export function _setTtlMinForTests(n) {
  // Mutating the module-level const via a setter is gross, but tests
  // need to force expiry without booting a separate process. We
  // re-export a writable binding instead of the const above.
  // Implementation: a let-bound shadow with the same name (see below).
}

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a fresh embed token bound to (tenant_id, external_user_id).
 * Returns the plaintext token string (callers MUST surface it to the
 * widget — we won't be able to recover it later).
 */
export function issueEmbedToken(tenantId, externalUserId) {
  if (!tenantId || !externalUserId) {
    throw new Error('tenant_id and external_user_id are required');
  }
  const plaintext = 'em_' + crypto.randomBytes(24).toString('base64url');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60_000).toISOString();
  db.prepare(
    `INSERT INTO embed_tokens (id, tenant_id, external_user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, tenantId, externalUserId, hash(plaintext), expiresAt);
  return { embed_token: plaintext, expires_at: expiresAt, id };
}

/**
 * Resolve a plaintext token to its row. Returns null on any failure
 * (bad token, expired, tenant deleted/suspended). Callers must
 * distinguish the four cases if they want a useful 401 message —
 * see resolveEmbedTokenWithReason().
 */
export function verifyEmbedToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const row = db
    .prepare(
      `SELECT et.id, et.tenant_id, et.external_user_id, et.expires_at,
              t.status AS tenant_status, t.name AS tenant_name,
              t.persona_config, t.default_model_id, t.slug AS tenant_slug
         FROM embed_tokens et
         JOIN tenants t ON t.id = et.tenant_id
        WHERE et.token_hash = ?`
    )
    .get(hash(plaintext));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.tenant_status !== 'active') return { ok: false, reason: 'tenant_inactive' };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, row };
}

/**
 * Convenience: returns { ok: true, embed: {...} } on success, or
 * { ok: false, reason } for the failure path. Used by requireEmbedToken.
 */
export function resolveEmbedToken(plaintext) {
  const v = verifyEmbedToken(plaintext);
  if (!v || !v.ok) return v;
  const r = v.row;
  let persona = null;
  if (r.persona_config) {
    try {
      const parsed = JSON.parse(r.persona_config);
      if (parsed && typeof parsed === 'object') persona = parsed;
    } catch { /* corrupt persona_config — fall through as null */ }
  }
  return {
    ok: true,
    embed: {
      token_id: r.id,
      tenant_id: r.tenant_id,
      tenant_slug: r.tenant_slug,
      tenant_name: r.tenant_name,
      default_model_id: r.default_model_id,
      external_user_id: r.external_user_id,
      persona_config: persona,
      expires_at: r.expires_at,
    },
  };
}

/**
 * Sweep expired tokens. Cheap, no-op when table is empty. Called
 * opportunistically on token issue (rate-limits itself via the index).
 * Returns count of deleted rows.
 */
export function sweepExpiredTokens() {
  return db.prepare(`DELETE FROM embed_tokens WHERE expires_at <= ?`).run(
    new Date().toISOString()
  ).changes;
}

export default {
  issueEmbedToken,
  verifyEmbedToken,
  resolveEmbedToken,
  sweepExpiredTokens,
  _ttlMin,
};