/**
 * requireEmbedToken — middleware for browser widget endpoints.
 *
 * Resolves the bearer embed_token (or ?embed_token= query for SSE
 * EventSource which can't set headers) and attaches req.embed:
 *   { token_id, tenant_id, tenant_slug, tenant_name, default_model_id,
 *     external_user_id, persona_config, expires_at }
 *
 * Failure modes:
 *   - missing/empty token            → 401 unauthorized
 *   - unknown / malformed token      → 401 invalid token
 *   - expired token                  → 401 token expired
 *   - tenant suspended / deleted     → 403 tenant not active
 *
 * On success, downstream handlers should treat req.embed.tenant_id as
 * the trust boundary: every session/messages/embeddings lookup MUST
 * include `owner_type = 'tenant' AND owner_id = ?` AND
 * `external_user_id = ?`.
 */

import { resolveEmbedToken } from '../embed-token.js';

function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.query.embed_token) return String(req.query.embed_token);
  return null;
}

export function requireEmbedToken(req, res, next) {
  const plaintext = readToken(req);
  if (!plaintext) {
    return res.status(401).json({ error: 'missing embed token' });
  }
  const result = resolveEmbedToken(plaintext);
  if (!result || !result.ok) {
    const reason = result?.reason || 'invalid';
    if (reason === 'expired') return res.status(401).json({ error: 'token expired' });
    if (reason === 'tenant_inactive') return res.status(403).json({ error: 'tenant not active' });
    return res.status(401).json({ error: 'invalid embed token' });
  }
  req.embed = result.embed;
  next();
}