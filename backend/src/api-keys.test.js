/**
 * API key lifecycle test. Talks to the real DB — these tests assume
 * a fresh-ish DB; the seed admin user from db/index.js is the user
 * we manage keys for.
 *
 * Run: node --test src/api-keys.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ensureUser() {
  // Find or create the dev admin user — matches server.js bootstrap.
  let row = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
  if (!row) {
    const info = db.prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES ('admin', NULL, 'admin', 'Admin')`
    ).run();
    row = { id: info.lastInsertRowid };
  }
  return row.id;
}

function cleanup(userId) {
  db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(userId);
}

test('create, lookup, revoke', () => {
  const userId = ensureUser();
  cleanup(userId);

  // Create
  const plaintext = `clw_${crypto.randomBytes(32).toString('hex')}`;
  const hash = sha256(plaintext);
  const ins = db
    .prepare(`INSERT INTO api_keys (user_id, name, model, key_hash) VALUES (?, ?, ?, ?)`)
    .run(userId, 'test-key', 'workspace', hash);
  const id = ins.lastInsertRowid;

  // Lookup by hash (this is what requireApiKey does)
  const row = db
    .prepare(`SELECT id, user_id, name, model FROM api_keys WHERE key_hash = ?`)
    .get(hash);
  assert.ok(row, 'key should be found by hash');
  assert.equal(row.user_id, userId);
  assert.equal(row.model, 'workspace');
  assert.equal(row.name, 'test-key');

  // Wrong hash → not found
  const wrong = db
    .prepare(`SELECT id FROM api_keys WHERE key_hash = ?`)
    .get(sha256('clw_wrong_key'));
  assert.equal(wrong, undefined);

  // Revoke
  db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
  const after = db
    .prepare(`SELECT id FROM api_keys WHERE key_hash = ?`)
    .get(hash);
  assert.equal(after, undefined);
});

test('cross-user isolation', () => {
  const userA = ensureUser();
  // Create a separate user to act as "user B"
  let userB = db.prepare(`SELECT id FROM users WHERE username = 'user-b-isolated'`).get();
  if (!userB) {
    const r = db.prepare(
      `INSERT INTO users (username, password, role) VALUES ('user-b-isolated', NULL, 'member')`
    ).run();
    userB = { id: r.lastInsertRowid };
  }

  cleanup(userA);
  db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(userB.id);

  const plaintext = `clw_${crypto.randomBytes(32).toString('hex')}`;
  const hash = sha256(plaintext);
  db.prepare(
    `INSERT INTO api_keys (user_id, name, model, key_hash) VALUES (?, ?, ?, ?)`
  ).run(userA, 'a-key', 'workspace', hash);

  // User B's middleware filter would scope by req.user.id → not A's.
  // Simulate that with a plain SELECT scoped to user B.
  const row = db
    .prepare(`SELECT id FROM api_keys WHERE user_id = ? AND key_hash = ?`)
    .get(userB.id, hash);
  assert.equal(row, undefined, 'user B must not see user A\'s keys');

  // Cleanup
  cleanup(userA);
  db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(userB.id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userB.id);
});