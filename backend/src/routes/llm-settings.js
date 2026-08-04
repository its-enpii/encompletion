/**
 * Per-user LLM settings — base_url, encrypted api_key, and import.
 *
 * Three endpoints, all under requireAuth (mounted in server.js):
 *
 *   GET  /api/llm-settings  — returns { configured, has_key,
 *                                  base_url_set, base_url }.
 *                                  NEVER returns the plaintext key.
 *                                  base_url is plaintext by design (it
 *                                  appears in every chat request
 *                                  anyway, so encrypting it adds no
 *                                  security).
 *
 *   PUT  /api/llm-settings  — upserts. Body:
 *     { base_url?: string, api_key?: string | null }
 *     - api_key omitted  → leave existing key in place
 *     - api_key: null    → delete the key (configured flips back to false)
 *     - api_key: "<str>" → encrypt + store
 *
 *   POST /api/llm-settings/test — body { base_url, api_key? }.
 *     Performs a HEAD on `<base_url>/models` with the supplied (or
 *     stored) key. Returns ok/401/timeout/network so the onboarding
 *     dialog can show a precise error.
 *
 * The key fingerprint shown in the dialog (`masked_key`) is derived
 * during PUT from the freshly-saved ciphertext via decryptSecret +
 * maskKey; the response is also used to update the client-side cache.
 *
 * The PUT path is idempotent. Concurrent saves are resolved by SQLite's
 * last-writer-wins; both save the same plaintext to the same column,
 * so the only loss is whether the user sees their old base_url or
 * the new one in the response, never which key is stored.
 */

import express from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { encryptSecret, decryptSecret, maskKey } from '../crypto-secrets.js';
import { getProviderStatus } from '../llm-provider.js';

const router = express.Router();

const MAX_KEY_LEN = 256;        // generous — real keys are <= 64 chars today
const MAX_BASE_URL_LEN = 512;
const TEST_TIMEOUT_MS = 15_000;

function isValidBaseUrl(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > MAX_BASE_URL_LEN) return false;
  // http(s):// only — block file://, javascript:, data:, etc.
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed);
}

/**
 * Read the row for the current user. Returns the row or null.
 */
function readSettingsRow(userId) {
  return db
    .prepare(
      `SELECT user_id, base_url, api_key_blob, compaction_model, extraction_model,
              created_at, updated_at
         FROM user_llm_settings WHERE user_id = ?`
    )
    .get(userId);
}

function publicView(row) {
  if (!row) {
    return {
      configured: false,
      has_key: false,
      base_url_set: false,
      base_url: '',
      masked_key: null,
    };
  }
  let masked = null;
  if (row.api_key_blob) {
    try {
      masked = maskKey(decryptSecret(row.api_key_blob));
    } catch {
      // If decryption fails, still report has_key=true (the row says so)
      // but no mask can be shown.
      masked = null;
    }
  }
  return {
    configured: !!(row.base_url && row.api_key_blob),
    has_key: !!row.api_key_blob,
    base_url_set: !!row.base_url,
    base_url: row.base_url || '',
    masked_key: masked,
    // Optional model overrides — null means "use the user's first imported".
    compaction_model: row.compaction_model || null,
    extraction_model: row.extraction_model || null,
    updated_at: row.updated_at,
  };
}

router.get('/', requireAuth, async (req, res) => {
  const row = readSettingsRow(req.user.id);
  res.json(publicView(row));
});

router.put('/', requireAuth, (req, res) => {
  const body = req.body || {};
  const updates = [];
  const params = [];

  if (body.base_url !== undefined) {
    if (typeof body.base_url !== 'string') {
      return res.status(400).json({ error: 'base_url must be a string' });
    }
    if (body.base_url !== '' && !isValidBaseUrl(body.base_url)) {
      return res.status(400).json({ error: 'base_url must be an http(s) URL' });
    }
    updates.push('base_url = ?'); params.push(body.base_url.trim());
  }

  if (body.api_key !== undefined) {
    if (body.api_key === null) {
      // Explicit clear
      updates.push('api_key_blob = NULL');
    } else if (typeof body.api_key !== 'string') {
      return res.status(400).json({ error: 'api_key must be a string or null' });
    } else {
      const trimmed = body.api_key.trim();
      if (!trimmed) {
        return res.status(400).json({ error: 'api_key cannot be empty (use null to delete)' });
      }
      if (trimmed.length > MAX_KEY_LEN) {
        return res.status(400).json({ error: `api_key too long (max ${MAX_KEY_LEN})` });
      }
      updates.push('api_key_blob = ?'); params.push(encryptSecret(trimmed));
    }
  }

  if (body.compaction_model !== undefined) {
    if (body.compaction_model === null) {
      updates.push('compaction_model = NULL');
    } else if (typeof body.compaction_model === 'string') {
      updates.push('compaction_model = ?'); params.push(body.compaction_model.trim());
    }
  }

  if (body.extraction_model !== undefined) {
    if (body.extraction_model === null) {
      updates.push('extraction_model = NULL');
    } else if (typeof body.extraction_model === 'string') {
      updates.push('extraction_model = ?'); params.push(body.extraction_model.trim());
    }
  }

  if (!updates.length) {
    return res.status(400).json({ error: 'no fields to update' });
  }

  const existing = db
    .prepare('SELECT user_id FROM user_llm_settings WHERE user_id = ?')
    .get(req.user.id);

  if (!existing) {
    // Create the first-row placeholder, then use the same UPDATE path as all
    // subsequent saves. UPDATE assignments such as `base_url = ?` are not
    // valid in an INSERT column list; reusing them there previously crashed
    // first-time onboarding before Express could send a response.
    db.prepare(
      'INSERT INTO user_llm_settings (user_id) VALUES (?)'
    ).run(req.user.id);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(
    `UPDATE user_llm_settings SET ${updates.join(', ')} WHERE user_id = ?`
  ).run(...params, req.user.id);

  const row = readSettingsRow(req.user.id);
  res.json(publicView(row));
});

router.post('/test', requireAuth, async (req, res) => {
  const body = req.body || {};
  const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
  if (!isValidBaseUrl(baseUrl)) {
    return res.status(400).json({ ok: false, error: 'invalid base_url' });
  }

  // Use the supplied key for the test (typical: user is still typing
  // and hasn't saved yet). If none supplied, fall back to the stored
  // key — useful when the user just changed base_url and wants to
  // re-test with the saved credentials.
  let testKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (!testKey) {
    const stored = readSettingsRow(req.user.id);
    if (stored?.api_key_blob) {
      try {
        testKey = decryptSecret(stored.api_key_blob);
      } catch {
        // Stored key is unreadable — let the test run without auth
        // header so the user sees the "needs key" failure mode.
        testKey = '';
      }
    }
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(testKey ? { Authorization: `Bearer ${testKey}` } : {}),
      },
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      return res.json({
        ok: false,
        status: r.status,
        error: `upstream HTTP ${r.status}`,
        detail,
      });
    }
    let body = null;
    try { body = await r.json(); } catch {}
    return res.json({ ok: true, status: r.status, sample: Array.isArray(body?.data) ? body.data.length : null });
  } catch (e) {
    return res.json({
      ok: false,
      error: e?.name === 'AbortError'
        ? `upstream timeout (>${TEST_TIMEOUT_MS}ms)`
        : (e?.message || String(e)),
    });
  } finally {
    clearTimeout(timer);
  }
});

/**
 * Sanity ping used by the bootstrap path. Returns the configured
 * status without any user input — frontend uses this on the
 * /onboarding route to decide whether to show the form or auto-
 * redirect to chat.
 */
router.get('/status', requireAuth, async (req, res) => {
  const status = await getProviderStatus(req.user.id);
  res.json(status);
});

export default router;