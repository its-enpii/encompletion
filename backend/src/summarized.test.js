/**
 * Summarized block renderer tests.
 *
 * Coverage:
 *  1. Empty/invalid sessionId → ''
 *  2. No row for session → ''
 *  3. Row exists → <system> block with prefix + summary text
 *  4. Long summary → sliced to SUMMARY_SNIPPET_MAX
 *  5. Whitespace collapsed (newlines → single space)
 *
 * Run: node --test src/summarized.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const {
  renderSessionSummaryBlock,
  _internals,
} = await import('./summarized.js');

const seeded = { sessions: [], summaries: [] };

function seedSession(userId) {
  const title = `sum-${crypto.randomBytes(3).toString('hex')}`;
  const id = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id)
       VALUES (?, 'workspace', ?, 'user', ?)`
    )
    .run(title, userId, String(userId)).lastInsertRowid;
  seeded.sessions.push(Number(id));
  return Number(id);
}

let aliceId;

before(() => {
  // Bootstrap a user for FK. Use a unique username so we don't
  // collide with prior tests that left users behind.
  const name = 'sum-' + crypto.randomBytes(3).toString('hex');
  aliceId = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, NULL, 'member', ?)`
    )
    .run(name, name).lastInsertRowid;
});

after(() => {
  for (const sid of seeded.sessions.splice(0)) {
    db.prepare(`DELETE FROM session_summaries WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  if (aliceId) db.prepare(`DELETE FROM users WHERE id = ?`).run(aliceId);
});

test('empty/invalid sessionId → ""', () => {
  assert.equal(renderSessionSummaryBlock(null), '');
  assert.equal(renderSessionSummaryBlock(undefined), '');
  assert.equal(renderSessionSummaryBlock(0), '');
});

test('no row for session → ""', () => {
  const sid = seedSession(aliceId);
  assert.equal(renderSessionSummaryBlock(sid), '');
});

test('row exists → returns <system> block with content + prefix', () => {
  const sid = seedSession(aliceId);
  db.prepare(
    `INSERT INTO session_summaries (session_id, summary, summarized_up_to, model)
     VALUES (?, ?, ?, ?)`
  ).run(sid, 'Topic: testing. Two facts: a, b.', 1, 'compactor');

  const out = renderSessionSummaryBlock(sid);
  assert.match(out, /^<system>\n/);
  assert.match(out, /Summary of this session's earlier turns \(newer turns are below verbatim\)/);
  assert.match(out, /Topic: testing\. Two facts: a, b\./);
  assert.match(out, /\n<\/system>$/);
});

test('long summary → sliced to SUMMARY_SNIPPET_MAX', () => {
  const sid = seedSession(aliceId);
  const longText = 'X'.repeat(_internals.SUMMARY_SNIPPET_MAX + 500);
  db.prepare(
    `INSERT INTO session_summaries (session_id, summary, summarized_up_to, model)
     VALUES (?, ?, ?, ?)`
  ).run(sid, longText, 1, 'compactor');

  const out = renderSessionSummaryBlock(sid);
  // Subtract the wrapper text (prefix + newline + suffix) to get the
  // inner payload length.
  const inner = out.replace(/^<system>\n.*\n/, '').replace(/\n<\/system>$/, '');
  assert.ok(inner.length <= _internals.SUMMARY_SNIPPET_MAX);
});

test('whitespace collapsed (newlines → single space)', () => {
  const sid = seedSession(aliceId);
  db.prepare(
    `INSERT INTO session_summaries (session_id, summary, summarized_up_to, model)
     VALUES (?, ?, ?, ?)`
  ).run(sid, 'line1\nline2\n\nline3', 1, 'compactor');

  const out = renderSessionSummaryBlock(sid);
  assert.match(out, /line1 line2 line3/);
  assert.ok(!out.includes('\nline2'));
});