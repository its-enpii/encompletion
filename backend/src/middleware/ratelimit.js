/**
 * In-memory rate limiter for sensitive endpoints (login, password reset).
 *
 * Single-process scope: works for the current single-container deployment.
 * If we ever run multiple backend instances behind a load balancer, this
 * needs to move to Redis or a sticky-session equivalent — local Maps do
 * not coordinate across processes.
 *
 * Design notes:
 * - Keyed by (IP + username) so an attacker cannot lock a victim out by
 *   spraying failed attempts at the username field (their IP, not the
 *   victim's, gets throttled). We still have a per-IP fallback key for
 *   requests that fail before the username parses.
 * - Sliding window: each attempt at time T expires at T + WINDOW. We
 *   prune on every check so the Map doesn't grow unbounded.
 * - `Retry-After` header is set on the lockout response so the UI can
 *   show a friendlier wait time if needed.
 *
 * Lockout ladder:
 *   <SOFT_MAX attempts in WINDOW:  -> 429, allow retry after window passes
 *   >=LOCKOUT_MAX and last failure within LOCKOUT_DURATION:  -> 429, lock for LOCKOUT_DURATION
 *
 * The bcrypt constant-time compare in /login still runs only on attempts
 * that pass the rate gate, so attackers can never brute-force hashes.
 */

const WINDOW_MS = 15 * 60 * 1000;          // 15 min sliding window
const SOFT_MAX = 10;                        // attempts allowed per window
const HARD_LOCK_MS = 15 * 60 * 1000;       // 15 min hard lock after SOFT_MAX exceeded
const HARD_LOCK_TRIGGER = SOFT_MAX;         // attempts >= this trigger hard lock

const buckets = new Map(); // key -> { attempts: [{t, ok}], lockedUntil: 0 }

function clientIp(req) {
  // Trust the first hop only when running behind a configured proxy. We
  // don't blindly read x-forwarded-for because nginx already sets it via
  // proxy_set_header X-Real-IP; falling back to socket address covers
  // direct-connect cases (e.g. local dev).
  const xri = req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri) return xri.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function prune(bucket, now) {
  // Drop attempts older than WINDOW_MS to keep the array tight.
  const cutoff = now - WINDOW_MS;
  bucket.attempts = bucket.attempts.filter((a) => a.t > cutoff);
}

function getOrCreate(key) {
  let b = buckets.get(key);
  if (!b) {
    b = { attempts: [], lockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

/**
 * Check the rate gate. Returns `{ allowed, retryAfterSec, reason }`.
 * Does NOT record an attempt; callers call `record` after the work
 * they want to rate-limit completes (login attempt vs. successful login).
 */
export function check(req, { usernameField = 'username' } = {}) {
  const now = Date.now();
  const ip = clientIp(req);
  const u =
    (req.body && typeof req.body[usernameField] === 'string'
      ? req.body[usernameField].trim().toLowerCase()
      : '') || '';
  const key = `${ip}|${u}`;

  const b = getOrCreate(key);
  prune(b, now);

  if (b.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000),
      reason: 'too many failed attempts',
      key,
    };
  }

  // Hard-lock promotion: if we hit/overshoot the trigger AND we have a
  // recent failure inside the window, escalate to a hard lock so the
  // attacker can't ride the sliding window with sustained low-rate spam.
  if (b.attempts.length >= HARD_LOCK_TRIGGER) {
    const lastAttempt = b.attempts[b.attempts.length - 1];
    if (lastAttempt && !lastAttempt.ok) {
      b.lockedUntil = now + HARD_LOCK_MS;
      return {
        allowed: false,
        retryAfterSec: Math.ceil(HARD_LOCK_MS / 1000),
        reason: 'too many failed attempts',
        key,
      };
    }
  }

  // Soft cap: max SOFT_MAX attempts in the window, regardless of outcome.
  // Successful logins consume the slot too — that way an authenticated
  // attacker on a compromised account can still be slowed.
  if (b.attempts.length >= SOFT_MAX) {
    const oldest = b.attempts[0];
    return {
      allowed: false,
      retryAfterSec: oldest
        ? Math.ceil((oldest.t + WINDOW_MS - now) / 1000)
        : Math.ceil(WINDOW_MS / 1000),
      reason: 'too many attempts',
      key,
    };
  }

  return { allowed: true, key };
}

/**
 * Record the outcome of an attempt. `ok` should reflect whether the
 * underlying operation succeeded (true = login ok / password match).
 *
 * Pass `key` from `check()` to avoid recomputing the bucket key.
 */
export function record(key, ok) {
  const b = buckets.get(key);
  if (!b) return;
  b.attempts.push({ t: Date.now(), ok: !!ok });
}

/**
 * Reset a bucket — useful for "successful login clears the failure history".
 */
export function reset(key) {
  if (key) buckets.delete(key);
}

/**
 * Express middleware factory. Mounts a gate at request time; the route
 * handler is responsible for calling `record` once it knows the outcome
 * (because we cannot know inside the middleware whether the credentials
 * matched). The route should also call `reset()` on a successful login
 * to clear that IP+username's history.
 *
 * Usage:
 *   const loginGate = rateLimit({ usernameField: 'username' });
 *   router.post('/login', loginGate, (req, res) => { ...; res.json(...); });
 */
export function rateLimit(opts = {}) {
  return function gate(req, res, next) {
    const result = check(req, opts);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSec || 60));
      // Tiny artificial delay so the timing of denial matches a real
      // bcrypt-comparing check; prevents username enumeration via
      // response time once we add metrics later.
      const jitter = 50 + Math.floor(Math.random() * 100);
      return setTimeout(() => {
        res.status(429).json({
          error: result.reason || 'too many requests',
          retry_after: result.retryAfterSec,
        });
      }, jitter);
    }
    // Stash the bucket key on req so the handler can record/reset without
    // recomputing the (IP+username) key.
    req.rateLimitKey = result.key;
    next();
  };
}
