/**
 * Tenant create + API key issuance tests (E3 follow-up).
 *
 * Coverage:
 *  1. POST /tenants returns 201 + full row
 *  2. POST /tenants rejects missing name/slug (400)
 *  3. POST /tenants rejects non-kebab slug (400)
 *  4. POST /tenants rejects duplicate slug (409)
 *  5. POST /tenants/:id/api-keys returns plaintext + prefix
 *  6. POST /tenants/:id/api-keys rejects suspended tenant (400)
 *  7. POST /tenants/:id/api-keys rejects unknown tenant (404)
 *  8. Issued key is queryable by hash via tenant_api_keys but plaintext is never re-served
 *  9. POST /tenants/:id/api-keys/:keyId/revoke sets revoked_at
 *
 * Run: node --test src/embed-tenant-create.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const embedAdminRouter = (await import('./routes/embed-admin.js')).default;

let server;
let port;

before(async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  // The router's global middleware (requireAuth + requireAdmin)
  // expects a real JWT. For tests we bypass it by extracting the
  // route handlers from the router stack and re-mounting only the
  // concrete handlers — Express's `router.stack` contains one Layer
  // per registered route whose `route.stack` is the chain of
  // handlers. We rebuild the route chain here so each path/method
  // matches without auth middleware in front.
  const fakeUser = { id: 1, username: 'admin', role: 'admin' };
  for (const layer of embedAdminRouter.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods);
    const path = layer.route.path;
    const handlers = layer.route.stack.map((s) => s.handle);
    for (const m of methods) {
      app[m](
        `/api/admin/embed${path}`,
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

after(() => { if (server) server.close(); });

const seeded = [];

function makeTenant(overrides = {}) {
  const slug = overrides.slug || 'tc-' + crypto.randomBytes(3).toString('hex');
  const id = 'tenant-' + crypto.randomBytes(6).toString('hex');
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)`
  ).run(id, overrides.name || 'Test Tenant', slug, overrides.status || 'active');
  seeded.push(id);
  return { id, slug, name: overrides.name || 'Test Tenant' };
}

function cleanup() {
  for (const id of seeded.splice(0)) {
    db.prepare(`DELETE FROM tenant_api_keys WHERE tenant_id = ?`).run(id);
    db.prepare(`DELETE FROM tenants WHERE id = ?`).run(id);
  }
}

async function postJSON(path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* may be empty */ }
  return { status: r.status, body: json };
}

test('POST /tenants returns 201 + full row', async () => {
  const slug = 'happy-' + crypto.randomBytes(3).toString('hex');
  const r = await postJSON('/api/admin/embed/tenants', {
    name: 'Happy Tenant',
    slug,
    status: 'active',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Happy Tenant');
  assert.equal(r.body.slug, slug);
  assert.equal(r.body.status, 'active');
  assert.ok(r.body.id?.startsWith('tenant-'));
  seeded.push(r.body.id);
});

test('POST /tenants rejects missing name/slug', async () => {
  const r1 = await postJSON('/api/admin/embed/tenants', { slug: 'x' });
  assert.equal(r1.status, 400);
  const r2 = await postJSON('/api/admin/embed/tenants', { name: 'X' });
  assert.equal(r2.status, 400);
});

test('POST /tenants rejects non-kebab slug', async () => {
  const r = await postJSON('/api/admin/embed/tenants', {
    name: 'Bad Slug', slug: 'Not_Kebab-Case',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /kebab/);
});

test('POST /tenants rejects duplicate slug (409)', async () => {
  const slug = 'dup-' + crypto.randomBytes(3).toString('hex');
  const t = makeTenant({ slug });
  const r = await postJSON('/api/admin/embed/tenants', { name: 'Dup', slug });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /slug/i);
});

test('POST /tenants/:id/api-keys returns plaintext once', async () => {
  const t = makeTenant();
  const r = await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'primary' });
  assert.equal(r.status, 201);
  assert.ok(r.body.plaintext.startsWith('tk_'), 'plaintext prefixed');
  assert.ok(r.body.prefix.endsWith('…'), 'prefix truncated');
  assert.equal(r.body.name, 'primary');
  assert.equal(r.body.tenant_id, t.id);

  // Verify only hash is stored.
  const row = db.prepare('SELECT key_hash FROM tenant_api_keys WHERE id = ?').get(r.body.id);
  assert.equal(row.key_hash.length, 64, 'sha256 hex = 64 chars');
  // And the hash matches sha256 of the plaintext.
  const expectedHash = crypto.createHash('sha256').update(r.body.plaintext).digest('hex');
  assert.equal(row.key_hash, expectedHash);
});

test('POST /tenants/:id/api-keys rejects unknown tenant (404)', async () => {
  const r = await postJSON('/api/admin/embed/tenants/tenant-does-not-exist/api-keys', { name: 'x' });
  assert.equal(r.status, 404);
});

test('POST /tenants/:id/api-keys rejects suspended tenant (400)', async () => {
  const t = makeTenant({ status: 'suspended' });
  const r = await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not active/i);
});

test('POST /tenants/:id/api-keys requires name', async () => {
  const t = makeTenant();
  const r = await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, {});
  assert.equal(r.status, 400);
});

test('GET /tenants/:id/api-keys lists keys without plaintext', async () => {
  const t = makeTenant();
  await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'first' });
  await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'second' });
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/embed/tenants/${t.id}/api-keys`);
  const list = await r.json();
  assert.equal(list.length, 2);
  // Critical: no plaintext in list response.
  for (const row of list) {
    assert.ok(!('plaintext' in row), 'plaintext NOT in list');
    assert.ok(!('key_hash' in row), 'key_hash NOT in list');
  }
});

test('POST /tenants/:id/api-keys/:keyId/revoke sets revoked_at', async () => {
  const t = makeTenant();
  const created = await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'to-revoke' });
  assert.equal(created.status, 201);
  const r = await fetch(
    `http://127.0.0.1:${port}/api/admin/embed/tenants/${t.id}/api-keys/${created.body.id}/revoke`,
    { method: 'POST' }
  );
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT revoked_at FROM tenant_api_keys WHERE id = ?').get(created.body.id);
  assert.ok(row.revoked_at, 'revoked_at populated');
});

test('revoke is idempotent: second revoke returns 404', async () => {
  const t = makeTenant();
  const created = await postJSON(`/api/admin/embed/tenants/${t.id}/api-keys`, { name: 'once' });
  const r1 = await fetch(
    `http://127.0.0.1:${port}/api/admin/embed/tenants/${t.id}/api-keys/${created.body.id}/revoke`,
    { method: 'POST' }
  );
  assert.equal(r1.status, 200);
  const r2 = await fetch(
    `http://127.0.0.1:${port}/api/admin/embed/tenants/${t.id}/api-keys/${created.body.id}/revoke`,
    { method: 'POST' }
  );
  assert.equal(r2.status, 404);
});

test('cleanup', () => cleanup());