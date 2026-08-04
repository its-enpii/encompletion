/**
 * llm-provider — typed error + resolver path.
 *
 * Resolver tests inject a stub DB via `_setProviderDbForTests` so the
 * suite runs without a built better-sqlite3 binding.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  LLMNotConfigured,
  resolveProviderFor,
  getProviderStatus,
  _setProviderDbForTests,
} from './llm-provider.js';
import { encryptSecret } from './crypto-secrets.js';

/** Minimal stub DB exposing the three prepared statements the
 *  resolver calls. Mirrors the shape better-sqlite3 returns. */
function makeStubDb(rows) {
  // rows = { settings: [...], user_models: [...] }
  const settingsMap = new Map(rows.settings.map((r) => [r.user_id, r]));
  const userModelsByKey = new Map(
    rows.user_models.map((r) => [r.user_id, new Map(r.keys.map((k) => [k.key, k]))])
  );
  function firstUserModel(userId) {
    const m = userModelsByKey.get(userId);
    if (!m) return undefined;
    return [...m.values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0];
  }
  return {
    prepare(sql) {
      return {
        get(userId) {
          if (/FROM user_llm_settings/.test(sql) && /SELECT base_url, api_key_blob/.test(sql)) {
            const row = settingsMap.get(userId);
            if (!row) return undefined;
            return { base_url: row.base_url, api_key_blob: row.api_key_blob };
          }
          if (/FROM user_llm_settings/.test(sql) && /SELECT base_url, api_key_blob, compaction_model, extraction_model/.test(sql)) {
            return settingsMap.get(userId);
          }
          if (/FROM user_models/.test(sql) && /SELECT 1 FROM user_models/.test(sql)) {
            // opts.model validation
            const m = sql.match(/key = \?/);
            if (!m) return undefined;
            // Pull the key arg from `this._args`. Simpler: stash on get args.
            return undefined; // overridden below
          }
          if (/FROM user_models/.test(sql) && /ORDER BY sort_order/.test(sql)) {
            return firstUserModel(userId);
          }
          return undefined;
        },
      };
    },
  };
}

let stubs = { settings: [], user_models: [] };

beforeEach(() => {
  stubs = { settings: [], user_models: [] };
  _setProviderDbForTests(makeStubDb(stubs));
});

test('LLMNotConfigured: typed error with code + reason + userId', () => {
  const e = new LLMNotConfigured('test reason', 42);
  assert.equal(e.code, 'LLM_NOT_CONFIGURED');
  assert.equal(e.name, 'LLMNotConfigured');
  assert.equal(e.userId, 42);
  assert.equal(e.reason, 'test reason');
  assert.ok(e instanceof Error);
});

test('resolveProviderFor(null/0/non-int) throws LLMNotConfigured', async () => {
  for (const bad of [null, undefined, 0, -1, 'abc', 1.5, NaN]) {
    await assert.rejects(
      () => resolveProviderFor(bad),
      (e) => e.code === 'LLM_NOT_CONFIGURED'
    );
  }
});

test('resolveProviderFor: no settings row throws LLMNotConfigured', async () => {
  // stubs is empty
  await assert.rejects(
    () => resolveProviderFor(7),
    (e) => e.code === 'LLM_NOT_CONFIGURED' && /no LLM settings row/.test(e.reason)
  );
});

test('resolveProviderFor: empty base_url throws LLMNotConfigured', async () => {
  stubs.settings = [{ user_id: 7, base_url: '', api_key_blob: encryptSecret('sk-x') }];
  _setProviderDbForTests(makeStubDb(stubs));
  await assert.rejects(
    () => resolveProviderFor(7),
    (e) => e.code === 'LLM_NOT_CONFIGURED' && /base_url is empty/.test(e.reason)
  );
});

test('resolveProviderFor: missing api_key throws LLMNotConfigured', async () => {
  stubs.settings = [{ user_id: 7, base_url: 'https://x/v1', api_key_blob: null }];
  _setProviderDbForTests(makeStubDb(stubs));
  await assert.rejects(
    () => resolveProviderFor(7),
    (e) => e.code === 'LLM_NOT_CONFIGURED' && /api_key is not set/.test(e.reason)
  );
});

test('resolveProviderFor: tampered api_key_blob throws LLMNotConfigured', async () => {
  stubs.settings = [{ user_id: 7, base_url: 'https://x/v1', api_key_blob: 'not-base64-garbage' }];
  _setProviderDbForTests(makeStubDb(stubs));
  await assert.rejects(
    () => resolveProviderFor(7),
    (e) => e.code === 'LLM_NOT_CONFIGURED' && /decrypt failed/.test(e.reason)
  );
});

test('resolveProviderFor: no imported models throws LLMNotConfigured', async () => {
  stubs.settings = [{ user_id: 7, base_url: 'https://x/v1', api_key_blob: encryptSecret('sk-x') }];
  stubs.user_models = [{ user_id: 7, keys: [] }];
  _setProviderDbForTests(makeStubDb(stubs));
  await assert.rejects(
    () => resolveProviderFor(7),
    (e) => e.code === 'LLM_NOT_CONFIGURED' && /no imported models/.test(e.reason)
  );
});

test('getProviderStatus: missing user returns all-false', async () => {
  const s = await getProviderStatus(99);
  assert.deepEqual(s, { configured: false, has_key: false, base_url_set: false });
});

test('getProviderStatus: configured=true when both base_url and key exist', async () => {
  stubs.settings = [{ user_id: 7, base_url: 'https://x/v1', api_key_blob: encryptSecret('sk-x') }];
  _setProviderDbForTests(makeStubDb(stubs));
  const s = await getProviderStatus(7);
  assert.equal(s.configured, true);
  assert.equal(s.has_key, true);
  assert.equal(s.base_url_set, true);
});

test('getProviderStatus: configured=false when base_url is set but key is missing', async () => {
  stubs.settings = [{ user_id: 7, base_url: 'https://x/v1', api_key_blob: null }];
  _setProviderDbForTests(makeStubDb(stubs));
  const s = await getProviderStatus(7);
  assert.equal(s.configured, false);
  assert.equal(s.has_key, false);
  assert.equal(s.base_url_set, true);
});