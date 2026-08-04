/**
 * LLM provider resolver — single source of truth for "what base URL
 * and API key should this user talk to?". Replaces the previous
 * `process.env.LLM_BASE_URL` / `process.env.LLM_API_KEY` reads that
 * lived in llm-runner.js, compactor.js, extractor.js, embedder.js,
 * and routes/models.js.
 *
 * Every user brings their own. The resolver looks up `user_llm_settings`
 * for `userId`, decrypts the API key (AES-256-GCM via crypto-secrets.js),
 * then picks the model:
 *   1. opts.model if it's a string in the user's imported list,
 *   2. else `opts.defaultKind === 'compactor' ? user.compaction_model :
 *      opts.defaultKind === 'extractor' ? user.extraction_model : null`,
 *   3. else the first enabled imported model,
 *   4. else throw `LLMNotConfigured`.
 *
 * All chat + worker HTTP paths funnel through here. If a user has no
 * settings row, or has a base_url but no key, the resolver throws and
 * the worker / route handler maps the error to the appropriate UX.
 *
 * The DB handle is loaded lazily so this module is importable from
 * test scripts that mock SQLite (or that don't have a built binary
 * yet). Production paths always go through the real `db/index.js`.
 */

import { decryptSecret } from './crypto-secrets.js';

export class LLMNotConfigured extends Error {
  constructor(reason, userId) {
    super(`LLM_NOT_CONFIGURED: ${reason} (user ${userId ?? '?'})`);
    this.code = 'LLM_NOT_CONFIGURED';
    this.name = 'LLMNotConfigured';
    this.userId = userId ?? null;
    this.reason = reason;
  }
}

let _db = null;
async function getDb() {
  if (_db) return _db;
  const mod = await import('./db/index.js');
  _db = mod.default;
  return _db;
}

/**
 * Allow tests to inject a stub DB. Production code never calls this.
 */
export function _setProviderDbForTests(dbHandle) {
  _db = dbHandle;
}

/**
 * Resolve the LLM provider for a user.
 *
 * @param {number|null} userId — the user whose creds to use. `null` /
 *   `undefined` always throws `LLMNotConfigured`.
 * @param {object} [opts]
 * @param {string} [opts.model]       — caller-suggested model key.
 * @param {'chat'|'compactor'|'extractor'} [opts.defaultKind='chat']
 *   — when `opts.model` is null/unknown, selects which user-saved
 *   override to honor (currently only `compactor`/`extractor` differ
 *   from chat — `chat` lets the runner pick the first imported model).
 *
 * @returns {Promise<{ baseUrl: string, apiKey: string, model: string }>}
 *
 * @throws {LLMNotConfigured}
 */
export async function resolveProviderFor(userId, opts = {}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new LLMNotConfigured('no user context', userId);
  }
  const db = await getDb();

  const settings = db
    .prepare(
      `SELECT base_url, api_key_blob, compaction_model, extraction_model
         FROM user_llm_settings
        WHERE user_id = ?`
    )
    .get(userId);

  if (!settings) {
    throw new LLMNotConfigured('user has no LLM settings row', userId);
  }
  const baseUrl = (settings.base_url || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new LLMNotConfigured('base_url is empty', userId);
  }
  if (!settings.api_key_blob) {
    throw new LLMNotConfigured('api_key is not set', userId);
  }
  let apiKey;
  try {
    apiKey = decryptSecret(settings.api_key_blob);
  } catch (e) {
    // Decryption failure (tampered DB / wrong key after a key rotation)
    // is treated as "not configured" so the UI can prompt for a fresh key.
    throw new LLMNotConfigured(`api_key decrypt failed: ${e?.message || e}`, userId);
  }
  if (!apiKey) {
    throw new LLMNotConfigured('api_key decrypted to empty string', userId);
  }

  // Pick the model. Caller-suggested key wins; otherwise consult the
  // user-saved override for this `defaultKind`; otherwise the first
  // enabled imported model.
  const suggested = typeof opts.model === 'string' ? opts.model.trim() : '';
  let model = '';
  if (suggested) {
    const ok = db
      .prepare(
        `SELECT 1 FROM user_models
          WHERE user_id = ? AND key = ? AND enabled = 1
          LIMIT 1`
      )
      .get(userId, suggested);
    if (ok) model = suggested;
  }
  if (!model) {
    if (opts.defaultKind === 'compactor' && settings.compaction_model) {
      model = settings.compaction_model;
    } else if (opts.defaultKind === 'extractor' && settings.extraction_model) {
      model = settings.extraction_model;
    }
  }
  if (!model) {
    const first = db
      .prepare(
        `SELECT key FROM user_models
          WHERE user_id = ? AND enabled = 1
          ORDER BY sort_order ASC, id ASC
          LIMIT 1`
      )
      .get(userId);
    model = first?.key || '';
  }
  if (!model) {
    throw new LLMNotConfigured('no imported models for user', userId);
  }

  return { baseUrl, apiKey, model };
}

/**
 * Cheap "is this user even configured" check — used by the first-run
 * gate (`/api/auth/me`) and by background workers (which then skip
 * rather than throw inside the hot loop). Reads settings row +
 * base_url existence only, never decrypts the key.
 */
export async function getProviderStatus(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { configured: false, has_key: false, base_url_set: false };
  }
  const db = await getDb();
  const row = db
    .prepare(
      `SELECT base_url, api_key_blob FROM user_llm_settings WHERE user_id = ?`
    )
    .get(userId);
  if (!row) return { configured: false, has_key: false, base_url_set: false };
  return {
    configured: !!(row.base_url && row.api_key_blob),
    has_key: !!row.api_key_blob,
    base_url_set: !!row.base_url,
  };
}

/**
 * Return a list of user IDs whose `user_llm_settings` row exists AND
 * has base_url + api_key set. Used by background workers to filter
 * the candidate SQL with `IN (...)` (less elegant than a JOIN but
 * the existing worker SQL is built around `s.user_id` lookups).
 */
export async function listConfiguredUserIds() {
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT user_id AS id FROM user_llm_settings
        WHERE base_url <> '' AND api_key_blob IS NOT NULL`
    )
    .all();
  return rows.map((r) => r.id);
}
