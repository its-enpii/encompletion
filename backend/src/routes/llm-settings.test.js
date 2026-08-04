/**
 * /api/llm-settings — round-trip + first-run gate.
 *
 * Uses node:http's `listen(0)` to spin up the router on a real port
 * and `fetch` to drive it. Mirrors the existing `users-pagination.test.js`
 * pattern. We don't need a built better-sqlite3 here — but the route
 * module imports `db/index.js` at the top, which does. So this test
 * requires the native binding. Run via:
 *
 *   node --test src/routes/llm-settings.test.js
 *
 * If the native binding isn't built, the test fails fast with a clear
 * "Could not locate the bindings file" error — same as the other
 * routes tests in this repo.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';

const db = (await import('../db/index.js')).default;
const { signToken } = await import('../middleware/auth.js');

const seededUserIds = [];
const seededSessionIds = [];

function seedUser(name) {
  const id = db
    .prepare(`INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`)
    .run(name, name).lastInsertRowid;
  seededUserIds.push(Number(id));
  return Number(id);
}

let aliceId;
let aliceToken;
let server;
let port;

before(async () => {
  aliceId = seedUser('alice-llm');
  aliceToken = signToken({ id: aliceId, username: 'alice-llm', role: 'member' });

  const llmSettingsRouter = (await import('./llm-settings.js')).default;
  const app = express();
  app.use(express.json());
  // Inject req.user the same way users-pagination.test.js does.
  const fakeUser = { id: aliceId, username: 'alice-llm', role: 'member' };
  for (const layer of llmSettingsRouter.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods);
    const path = layer.route.path;
    const handlers = layer.route.stack.map((s) => s.handle);
    for (const m of methods) {
      app[m](
        `/api/llm-settings${path}`,
        (req, _res, next) => { req.user = fakeUser; next(); },
        ...handlers,
      );
    }
  }
  await new Promise((resolve) => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const sid of seededSessionIds.splice(0)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  }
  for (const uid of seededUserIds.splice(0)) {
    db.prepare('DELETE FROM user_llm_settings WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  }
});

function get(path) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  });
}
function put(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify(body),
  });
}
function post(path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` },
    body: JSON.stringify(body || {}),
  });
}

test('GET /api/llm-settings: empty row returns all-false', async () => {
  // Clean slate
  db.prepare('DELETE FROM user_llm_settings WHERE user_id = ?').run(aliceId);
  const r = await get('/api/llm-settings');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.configured, false);
  assert.equal(j.has_key, false);
  assert.equal(j.base_url_set, false);
  assert.equal(j.base_url, '');
  assert.equal(j.masked_key, null);
});

test('PUT base_url + api_key: configured flips to true, has_key true', async () => {
  const r = await put('/api/llm-settings', {
    base_url: 'https://ai.example.com/v1',
    api_key: 'sk-test-1234567890abcd',
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.configured, true);
  assert.equal(j.has_key, true);
  assert.equal(j.base_url_set, true);
  assert.equal(j.base_url, 'https://ai.example.com/v1');
  assert.equal(j.masked_key, '…abcd');
});

test('NO PLAINTEXT KEY in any response body after save', async () => {
  // Re-PUT to refresh the row
  await put('/api/llm-settings', {
    base_url: 'https://ai.example.com/v1',
    api_key: 'sk-secret-plaintext-1234abcd',
  });
  // GET response
  const r1 = await get('/api/llm-settings');
  const txt1 = JSON.stringify(await r1.json());
  assert.ok(!txt1.includes('sk-secret-plaintext'), 'plaintext must NOT appear in GET');

  // PUT response
  const r2 = await put('/api/llm-settings', {
    base_url: 'https://ai.example.com/v1',
    api_key: 'sk-secret-plaintext-1234abcd',
  });
  const txt2 = JSON.stringify(await r2.json());
  assert.ok(!txt2.includes('sk-secret-plaintext'), 'plaintext must NOT appear in PUT');

  // status response
  const r3 = await get('/api/llm-settings/status');
  const txt3 = JSON.stringify(await r3.json());
  assert.ok(!txt3.includes('sk-secret-plaintext'), 'plaintext must NOT appear in /status');
});

test('api_key: null flips configured back to false (cleared key)', async () => {
  await put('/api/llm-settings', {
    base_url: 'https://ai.example.com/v1',
    api_key: 'sk-keep-1234abcd',
  });
  let j = await (await get('/api/llm-settings')).json();
  assert.equal(j.configured, true);

  const r = await put('/api/llm-settings', {
    base_url: 'https://ai.example.com/v1',
    api_key: null,
  });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.configured, false);
  assert.equal(j.has_key, false);
  assert.equal(j.base_url_set, true);
  assert.equal(j.masked_key, null);
});

test('PUT without fields returns 400', async () => {
  const r = await put('/api/llm-settings', {});
  assert.equal(r.status, 400);
});

test('PUT rejects invalid base_url', async () => {
  for (const bad of ['', 'not-a-url', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const r = await put('/api/llm-settings', { base_url: bad });
    assert.equal(r.status, 400, `expected 400 for "${bad}"`);
  }
});

test('PUT rejects empty-string api_key (use null to clear)', async () => {
  const r = await put('/api/llm-settings', { api_key: '' });
  assert.equal(r.status, 400);
});

test('status endpoint reflects stored state', async () => {
  await put('/api/llm-settings', {
    base_url: 'https://x.example.com/v1',
    api_key: 'sk-status-check-abcd',
  });
  const r = await get('/api/llm-settings/status');
  const j = await r.json();
  assert.equal(j.configured, true);
  assert.equal(j.has_key, true);
  assert.equal(j.base_url_set, true);
});
