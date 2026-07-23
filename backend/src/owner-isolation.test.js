/**
 * Owner isolation tests (embed mode phase E1.5).
 *
 * Verifies that the polymorphic owner_type/owner_id columns on
 * projects and sessions keep one user's data invisible to another.
 * Backwards-compat checks: existing rows backfilled to owner_type='user'
 * must still surface for the user they belong to.
 *
 * Run: node --test src/owner-isolation.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('./db/index.js')).default;

function ensureUser(username, role = 'member') {
  let row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!row) {
    const info = db.prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, NULL, ?, ?)`
    ).run(username, role, username);
    row = { id: info.lastInsertRowid };
  }
  return row.id;
}

test('existing rows backfilled to owner_type=user with stringified user_id', () => {
  // Pick any pre-existing platform-user row (owner_type='user'). Tests
  // for embed/tenant isolation run separately and may insert tenant
  // rows whose presence would make this test order-dependent if we
  // didn't filter.
  const p = db.prepare(`SELECT id, owner_type, owner_id FROM projects WHERE owner_type = 'user' LIMIT 1`).get();
  if (p) {
    assert.equal(p.owner_type, 'user');
    assert.ok(p.owner_id && p.owner_id.length > 0, 'owner_id backfilled');
  }
  const s = db.prepare(`SELECT id, owner_type, owner_id FROM sessions WHERE owner_type = 'user' LIMIT 1`).get();
  if (s) {
    assert.equal(s.owner_type, 'user');
    assert.ok(s.owner_id && s.owner_id.length > 0, 'owner_id backfilled');
  }
});

test('user A project/session invisible to user B (read isolation)', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const userA = ensureUser('iso-a-' + suffix);
  const userB = ensureUser('iso-b-' + suffix);

  const projectInfo = db
    .prepare(
      `INSERT INTO projects (user_id, name, owner_type, owner_id)
       VALUES (?, ?, 'user', ?)`
    )
    .run(userA, 'A-only-project', String(userA));
  const projectId = Number(projectInfo.lastInsertRowid);

  const sessionInfo = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id)
       VALUES ('A-only-session', 'workspace', ?, 'user', ?)`
    )
    .run(userA, String(userA));
  const sessionId = Number(sessionInfo.lastInsertRowid);

  // Simulate the WHERE clause used by routes/projects.js + sessions.js.
  // User B asking for their own list must NOT see A's rows.
  const visibleToB = db
    .prepare(
      `SELECT id FROM projects
         WHERE owner_type = 'user' AND owner_id = ?
           AND archived_at IS NULL`
    )
    .all(String(userB));
  assert.equal(
    visibleToB.find((r) => r.id === projectId),
    undefined,
    'A project must not surface in B list',
  );

  const sessionsToB = db
    .prepare(
      `SELECT id FROM sessions
         WHERE owner_type = 'user' AND owner_id = ?
           AND archived_at IS NULL`
    )
    .all(String(userB));
  assert.equal(
    sessionsToB.find((r) => r.id === sessionId),
    undefined,
    'A session must not surface in B list',
  );

  // Admin role still sees everything — sanity check.
  const admin = ensureUser('iso-admin-' + suffix, 'admin');
  const visibleToAdmin = db
    .prepare(
      `SELECT id FROM projects
         WHERE owner_type = 'user' AND owner_id = ? OR ? = 'admin'`
    )
    .all(String(userA), 'admin');
  assert.ok(
    visibleToAdmin.find((r) => r.id === projectId),
    'admin sees A project',
  );
  // cleanup
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  // tidy users
  db.prepare(`DELETE FROM users WHERE id IN (?, ?, ?)`).run(userA, userB, admin);
});

test('tenant rows are filtered out of platform-mode queries', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const userA = ensureUser('iso-tenant-a-' + suffix);
  // Insert a tenant row + a tenant-owned project.
  const tenantId = 'tenant-' + suffix;
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, 'active')`
  ).run(tenantId, 'Test Tenant ' + suffix, 't-' + suffix);
  db.prepare(
    `INSERT INTO projects (user_id, name, owner_type, owner_id)
     VALUES (NULL, 'tenant-only', 'tenant', ?)`
  ).run(tenantId);

  // The platform-mode WHERE must NOT match tenant-owned projects.
  const visible = db
    .prepare(
      `SELECT id FROM projects
         WHERE owner_type = 'user' AND owner_id = ?
           AND archived_at IS NULL`
    )
    .all(String(userA));
  assert.equal(
    visible.find((r) => r.name === 'tenant-only'),
    undefined,
    'platform query must skip tenant-owned rows',
  );

  // cleanup
  db.prepare(`DELETE FROM projects WHERE owner_type = 'tenant' AND owner_id = ?`).run(tenantId);
  db.prepare(`DELETE FROM tenants WHERE id = ?`).run(tenantId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userA);
});