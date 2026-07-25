/**
 * Per-user system prompt DB tests. Talks to the real DB; uses
 * timestamped usernames to avoid collisions across reruns.
 *
 * Coverage:
 *   1. no row → undefined (caller falls back to default const)
 *   2. upsert via setPrompt, then read back
 *   3. null round-trips as null (UI "reset" path)
 *   4. cross-user isolation — A's prompt never visible to B
 *
 * Run: node --test src/system-prompt.test.js
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

function setPrompt(userId, text) {
  const exists = db
    .prepare('SELECT id FROM user_settings WHERE user_id = ?')
    .get(userId);
  if (exists) {
    db.prepare(
      'UPDATE user_settings SET system_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'
    ).run(text, userId);
  } else {
    db.prepare(
      'INSERT INTO user_settings (user_id, system_prompt) VALUES (?, ?)'
    ).run(userId, text);
  }
}

function getPromptRow(userId) {
  return db
    .prepare('SELECT system_prompt FROM user_settings WHERE user_id = ?')
    .get(userId);
}

test('no row → read returns undefined (caller falls back)', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const uid = ensureUser('sp-default-' + suffix);
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(uid);
  assert.equal(getPromptRow(uid), undefined);
});

test('upsert via setPrompt, then read', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const uid = ensureUser('sp-save-' + suffix);
  setPrompt(uid, 'You are a pirate. Answer in pirate speak.');
  const row = getPromptRow(uid);
  assert.ok(row, 'row exists after upsert');
  assert.equal(row.system_prompt, 'You are a pirate. Answer in pirate speak.');
});

test('null round-trips as null (UI reset path)', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const uid = ensureUser('sp-null-' + suffix);
  setPrompt(uid, null);
  const row = getPromptRow(uid);
  assert.ok(row, 'row created so the user_settings row exists');
  assert.equal(row.system_prompt, null);
});

test('cross-user isolation', () => {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const a = ensureUser('sp-iso-a-' + suffix);
  const b = ensureUser('sp-iso-b-' + suffix);
  setPrompt(a, 'A prompt');
  setPrompt(b, 'B prompt');
  assert.equal(getPromptRow(a).system_prompt, 'A prompt');
  assert.equal(getPromptRow(b).system_prompt, 'B prompt');
});
