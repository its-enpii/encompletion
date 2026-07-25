/**
 * Users pagination + search filter tests.
 *
 * Coverage:
 *  1. Default response shape: { users, total, limit, offset }
 *  2. Pagination boundaries: page 1 (offset 0) + page 2 (offset N)
 *  3. limit > 500 capped at 500
 *  4. Search narrows results; total reflects filter
 *  5. Sort column whitelist: unknown column falls back to id
 *  6. Sort dir: desc reverses order
 *  7. Empty filter, no users → empty users array, total 0
 *
 * Tests hit the route handler directly with a stubbed req/res — no
 * HTTP, no express. Pure logic coverage.
 *
 * Run: node --test src/users-pagination.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const usersRouter = (await import('./routes/users.js')).default;

let server;
let port;

before(async () => {
  // Spin up a tiny Express server. The users router's GET / has
  // requireAdmin baked in (route-level middleware), so we extract
  // the handlers from the router stack and re-mount them with a
  // fake req.user injection in front — same trick as the embed
  // tenant tests.
  const express = (await import('express')).default;
  const app = express();
  const fakeUser = { id: 1, username: 'admin', role: 'admin' };
  for (const layer of usersRouter.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods);
    const path = layer.route.path;
    const handlers = layer.route.stack.map((s) => s.handle);
    for (const m of methods) {
      app[m](
        `/api/users${path}`,
        (req, _res, next) => { req.user = fakeUser; next(); },
        ...handlers
      );
    }
  }
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

// Test seed management: track users we create so we can clean up.
const seeded = [];

function seedUser(role = 'member', display = null) {
  const username = 'pgtst-' + crypto.randomBytes(4).toString('hex');
  const info = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, NULL, ?, ?)`
    )
    .run(username, role, display || username);
  const id = Number(info.lastInsertRowid);
  seeded.push(id);
  return { id, username, display_name: display || username, role };
}

function cleanup() {
  for (const id of seeded.splice(0)) {
    try { db.prepare(`DELETE FROM users WHERE id = ?`).run(id); } catch { /* FK */ }
  }
}

async function fetchList(qs = '') {
  const url = `http://127.0.0.1:${port}/api/users${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { redirect: 'follow' });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, url };
}

test('default response shape: { users, total, limit, offset }', async () => {
  const { status, body } = await fetchList();
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.users), 'users array');
  assert.equal(typeof body.total, 'number');
  assert.ok(body.limit > 0);
  assert.ok(body.offset >= 0);
  // First user in list is the admin bootstrap row (id 1).
  assert.ok(body.users.length > 0, 'at least one user from bootstrap');
});

test('pagination boundaries: page 1 + page 2 disjoint, total reflects both', async () => {
  cleanup();
  for (let i = 0; i < 12; i++) seedUser('member', `User ${String(i).padStart(2, '0')}`);
  try {
    const p1 = await fetchList('limit=5&offset=0&sort=id&dir=asc');
    const p2 = await fetchList('limit=5&offset=5&sort=id&dir=asc');
    const p3 = await fetchList('limit=5&offset=10&sort=id&dir=asc');

    assert.ok(p1.body.total >= 12 + 1, 'total includes admin + 12 seeded'); // +1 bootstrap admin
    assert.equal(p1.body.users.length, 5);
    assert.equal(p2.body.users.length, 5);
    assert.equal(p3.body.users.length, Math.min(5, p1.body.total - 10));

    // Disjoint ids across pages.
    const ids = new Set();
    for (const u of [...p1.body.users, ...p2.body.users, ...p3.body.users]) ids.add(u.id);
    assert.equal(ids.size, p1.body.users.length + p2.body.users.length + p3.body.users.length);
  } finally {
    cleanup();
  }
});

test('limit > 500 capped at 500', async () => {
  const { body } = await fetchList('limit=9999');
  assert.equal(body.limit, 500, 'capped to 500');
  assert.ok(body.users.length <= 500);
});

test('limit <= 0 and non-numeric fall back to default 50', async () => {
  // limit=0   → invalid, default 50
  // limit=-5  → invalid, default 50 (not clamped to 1, since we'd
  //             rather keep the page size predictable)
  // limit=abc → non-numeric, default 50
  const r0 = await fetchList('limit=0');
  assert.equal(r0.body.limit, 50, 'limit=0 → 50');
  const rNeg = await fetchList('limit=-5');
  assert.equal(rNeg.body.limit, 50, 'limit=-5 → 50');
  const rAlpha = await fetchList('limit=abc');
  assert.equal(rAlpha.body.limit, 50, 'limit=abc → 50');
});

test('search narrows results; total reflects filter', async () => {
  cleanup();
  seedUser('member', 'Alan Turing');
  seedUser('member', 'Grace Hopper');
  seedUser('member', 'Bob Dylan');
  try {
    const r = await fetchList('q=Alan');
    assert.equal(r.status, 200);
    assert.ok(r.body.users.length >= 1, 'finds Alan');
    for (const u of r.body.users) {
      const hay = `${u.username} ${u.display_name || ''}`.toLowerCase();
      assert.ok(hay.includes('alan'), `row matches search: ${hay}`);
    }
    // Total should be lower than no-filter total.
    const all = await fetchList('');
    assert.ok(r.body.total <= all.body.total);
  } finally {
    cleanup();
  }
});

test('sort whitelist: unknown column falls back to id', async () => {
  const r = await fetchList('sort=password_hash');
  assert.equal(r.status, 200);
  // Order should still be ascending by id — first user is admin (id=1).
  if (r.body.users.length > 0) {
    assert.ok(r.body.users[0].id <= r.body.users[r.body.users.length - 1].id, 'ascending by id');
  }
});

test('sort dir desc reverses order', async () => {
  const r = await fetchList('sort=id&dir=desc&limit=5');
  assert.equal(r.status, 200);
  if (r.body.users.length >= 2) {
    assert.ok(r.body.users[0].id >= r.body.users[1].id, 'descending by id');
  }
});

test('empty result set returns empty array + total 0', async () => {
  const r = await fetchList('q=zzz-no-match-' + crypto.randomBytes(4).toString('hex'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.users, []);
  assert.equal(r.body.total, 0);
});