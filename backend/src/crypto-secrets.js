/**
 * Server-side encryption for per-user secrets (API keys).
 *
 * Threat model
 * ────────────
 * This module defends against DIRECT SQLite file exfiltration: an
 * attacker who copies the DB file off disk cannot read the API keys
 * without also gaining code execution in the server process where the
 * key material sits in memory. It does NOT defend against server
 * compromise. Anyone who can run code on the live process can call
 * `decryptSecret` and get every key back.
 *
 * Key derivation
 * ──────────────
 * The AES-256-GCM key is `SHA-256("encompletion-llm-settings-v1" || SECRET)`
 * where SECRET is `LLM_SETTINGS_SECRET` if set, otherwise `JWT_SECRET`
 * (the same fallback the existing JWT layer uses — keeps one secret
 * to operate). The domain tag prevents accidental reuse of the raw
 * JWT secret bytes for a different purpose.
 *
 * Production refuses to boot without a secret. In development we fall
 * back to `JWT_SECRET` first, then a built-in dev-only string with a
 * loud warning (matching `middleware/auth.js`).
 *
 * Ciphertext layout
 * ─────────────────
 * Single base64 string: `iv(12) || ciphertext(?) || tag(16)`.
 * Stored as TEXT in SQLite. One column to keep in sync with the
 * cipher state, instead of three ("stale IV + new tag" bugs).
 */

import crypto from 'node:crypto';

const DOMAIN_TAG = 'encompletion-llm-settings-v1';
const NODE_ENV = process.env.NODE_ENV || 'development';

const DEV_FALLBACK_SECRET = 'dev-insecure-llm-secret-change-me';

const rawSecret =
  process.env.LLM_SETTINGS_SECRET ||
  process.env.JWT_SECRET ||
  (NODE_ENV === 'production' ? null : DEV_FALLBACK_SECRET);

if (!rawSecret) {
  throw new Error(
    '[crypto-secrets] LLM_SETTINGS_SECRET (or JWT_SECRET) must be set in production'
  );
}

if (
  NODE_ENV !== 'production' &&
  !process.env.LLM_SETTINGS_SECRET &&
  !process.env.JWT_SECRET
) {
  console.warn(
    '[crypto-secrets] no LLM_SETTINGS_SECRET or JWT_SECRET — using insecure development fallback. ' +
      'Set LLM_SETTINGS_SECRET in production.'
  );
}

const KEY = crypto.createHash('sha256').update(DOMAIN_TAG).update(rawSecret).digest();

/**
 * Encrypts a UTF-8 string. Returns a base64 blob (`iv||ct||tag`).
 * Generates a fresh 12-byte random IV per call.
 */
export function encryptSecret(plain) {
  if (typeof plain !== 'string') {
    throw new TypeError('encryptSecret expects a string');
  }
  if (plain.length === 0) {
    throw new Error('encryptSecret refuses empty strings — pass null to clear a key');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

/**
 * Decrypts a blob produced by encryptSecret. Returns the UTF-8 string.
 * Throws on tag mismatch (tampered ciphertext OR wrong key).
 */
export function decryptSecret(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new TypeError('decryptSecret expects a non-empty base64 string');
  }
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 12 + 16) {
    throw new Error('decryptSecret: ciphertext truncated');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Mask a plaintext key for display: `"sk-1234567890abcd"` →
 * `"sk-…abcd"` (last 4 chars, hide the rest). For keys shorter than
 * 8 chars we keep just 2 trailing dots for safety.
 */
export function maskKey(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return null;
  if (plain.length <= 4) return '••••';
  return '…' + plain.slice(-4);
}

/**
 * Derive a stable, *masked-only* fingerprint from a plaintext key.
 * Different from maskKey: callers that want the same fingerprint for
 * the same plaintext use this. Currently only used for the optimistic
 * "key looks like this" hint after a save.
 */
export function fingerprintKey(plain) {
  return maskKey(plain);
}
