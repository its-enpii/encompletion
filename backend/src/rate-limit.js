/**
 * rate-limit — in-process token-bucket per tenant.
 *
 * Capacity and refill rate are per-tenant, looked up from
 * tenant_capability_profile.rate_limit_override. Missing row or 0 =
 * use the global default (DEFAULT_RATE_PER_MIN).
 *
 * The bucket is in-memory only — restart resets state, but that's
 * acceptable for a small SaaS; the long-lived rate limit belongs at
 * the edge proxy (nginx) in production.
 *
 * Apply: as middleware to /api/embed/* routes AFTER requireEmbedToken,
 * so the bucket key is the verified tenant_id.
 */

import db from './db/index.js';

const DEFAULT_RATE_PER_MIN = parseInt(process.env.EMBED_RATE_LIMIT || '60', 10);
const REFILL_INTERVAL_MS = 60_000;

// Map<tenantId, { tokens, lastRefill, capacity, rate }>
const buckets = new Map();

function effectiveRate(tenantId) {
  try {
    const row = db
      .prepare(`SELECT rate_limit_override FROM tenant_capability_profile WHERE tenant_id = ?`)
      .get(tenantId);
    if (row && row.rate_limit_override && row.rate_limit_override > 0) {
      return row.rate_limit_override;
    }
  } catch { /* fall through to default */ }
  return DEFAULT_RATE_PER_MIN;
}

function bucketFor(tenantId) {
  let b = buckets.get(tenantId);
  if (!b) {
    const rate = effectiveRate(tenantId);
    b = { tokens: rate, lastRefill: Date.now(), capacity: rate, rate };
    buckets.set(tenantId, b);
  }
  return b;
}

function refill(b, tenantId) {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed <= 0) return;
  // Refill at the configured rate, prorated by elapsed time.
  const refillTokens = (elapsed / REFILL_INTERVAL_MS) * b.rate;
  b.tokens = Math.min(b.capacity, b.tokens + refillTokens);
  b.lastRefill = now;
}

/**
 * Try to consume 1 token from the tenant's bucket. Returns
 * { ok: true } on success or { ok: false, retryAfterMs } when the
 * bucket is dry.
 *
 * `tenantId` is mandatory — if the caller can't supply one, the
 * middleware should reject the request earlier. We don't allow
 * "anonymous" buckets.
 */
export function consumeToken(tenantId) {
  if (!tenantId) return { ok: false, retryAfterMs: REFILL_INTERVAL_MS };
  const b = bucketFor(tenantId);
  refill(b, tenantId);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, remaining: Math.floor(b.tokens) };
  }
  // Compute when the bucket will have 1 full token again.
  const need = 1 - b.tokens;
  const retryAfterMs = Math.ceil((need / b.rate) * REFILL_INTERVAL_MS);
  return { ok: false, retryAfterMs };
}

/**
 * Express middleware factory. Returns a middleware that checks the
 * tenant's bucket and short-circuits with 429 + Retry-After when
 * exhausted.
 *
 * Usage:
 *   const limit = makeRateLimitMiddleware();
 *   router.post('/sessions/:id/runs', requireEmbedToken, limit, handler);
 */
export function makeRateLimitMiddleware() {
  return function rateLimitMiddleware(req, res, next) {
    const tenantId = req.embed?.tenant_id;
    if (!tenantId) {
      // Not an embed-authed request — bypass (other routes have their
      // own gates). Defensive: never block if we can't identify the
      // tenant; that's a programming error, not a rate-limit case.
      return next();
    }
    const result = consumeToken(tenantId);
    if (!result.ok) {
      res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
      return res.status(429).json({
        error: 'rate limit exceeded',
        retry_after_ms: result.retryAfterMs,
      });
    }
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    next();
  };
}

export function _resetForTests() {
  buckets.clear();
}

export const rateLimitMiddleware = makeRateLimitMiddleware;

export default { consumeToken, makeRateLimitMiddleware, rateLimitMiddleware, _resetForTests };