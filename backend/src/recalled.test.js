/**
 * Cross-session recall tests.
 *
 * Uses EMBED_PROVIDER=fake so no real model is needed and we can
 * control embedding semantics. Tests mutate module-level state in
 * rag.js (activeDim, embeddings_chunk) so they run with concurrency
 * disabled.
 *
 * Coverage:
 *  1. renderRecalledContextBlock returns '' for empty userId
 *  2. Short query (< MIN_QUERY_LEN) → ''
 *  3. No indexed messages → ''
 *  4. Indexed message + similar query → block contains snippet
 *  5. Per-user isolation: user B doesn't see user A's chunks
 *  6. Session exclusion: current session's chunks filtered out
 *  7. Block format: <system> wrapper + bullet list + </system>
 *
 * Run: EMBED_PROVIDER=fake EMBED_FAKE_DIM=4 node --test src/recalled.test.js
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.EMBED_PROVIDER = 'fake';
process.env.EMBED_FAKE_DIM = '4';

const { embed, _resetForTests: resetEmbed } = await import('./embedder.js');
const rag = (await import('./rag.js')).default;
const { default: db } = await import('./db/index.js');
const {
  renderRecalledContextBlock,
  _internals,
} = await import('./recalled.js');

const seeded = { users: [], sessions: [], messages: [], chunks: [] };

function seedUser(name = 'rec-' + crypto.randomBytes(3).toString('hex')) {
  const id = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`
    )
    .run(name, name).lastInsertRowid;
  seeded.users.push(Number(id));
  return Number(id);
}

function seedSession(userId) {
  const id = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id)
       VALUES (?, 'workspace', ?, 'user', ?)`
    )
    .run(`rec-${crypto.randomBytes(3).toString('hex')}`, userId, String(userId)).lastInsertRowid;
  seeded.sessions.push(Number(id));
  return Number(id);
}

function seedMessage(sessionId, userId, content) {
  // userId not stored on messages — the rag path joins through sessions.
  // We accept it as a parameter for ergonomic test code but don't write it.
  const id = db
    .prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
    .run(sessionId, content).lastInsertRowid;
  seeded.messages.push(Number(id));
  return Number(id);
}

before(async () => {
  await embed(['warmup']);
});

beforeEach(() => {
  // Wipe any pre-existing chunks so tests don't cross-pollute.
  db.prepare(`DELETE FROM embeddings_session`).run();
  db.prepare(`DELETE FROM embeddings_chunk`).run();
});

after(() => {
  // Cleanup in reverse FK order.
  for (const mid of seeded.messages.splice(0)) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(mid);
  }
  for (const sid of seeded.sessions.splice(0)) {
    db.prepare(`DELETE FROM embeddings_session WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  for (const uid of seeded.users.splice(0)) {
    db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);
  }
  resetEmbed();
});

test('empty userId → ""', async () => {
  const out = await renderRecalledContextBlock(null, 'something to ask about');
  assert.equal(out, '');
});

test('short query (< MIN_QUERY_LEN) → ""', async () => {
  const userId = seedUser();
  const out = await renderRecalledContextBlock(userId, 'ok');
  assert.equal(out, '');
});

test('no indexed messages → ""', { concurrency: false }, async () => {
  const userId = seedUser();
  const out = await renderRecalledContextBlock(
    userId,
    'How should I lay out my Python project?'
  );
  assert.equal(out, '');
});

test('indexed message + similar query → block contains snippet', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  // Pasted deterministic content — the 'fake' embedder hashes the
  // tokens, so a query that shares most tokens should land near the
  // indexed content in cosine space.
  const content = 'Specific phrase: ZULU-FOO fastapi repository layout module structure python';
  const mid = seedMessage(sessionId, userId, content);
  await rag.indexSource({ kind: 'user_message', id: mid, content, sessionId });

  // Query from a DIFFERENT session for the same user — cross-session.
  const otherSessionId = seedSession(userId);
  const out = await renderRecalledContextBlock(
    userId,
    'fastapi repository layout module structure',
    otherSessionId
  );
  assert.ok(out.startsWith('<system>\n'), 'starts with <system> tag');
  assert.ok(out.endsWith('</system>'), 'ends with </system>');
  assert.match(out, /Recalled context from your past chats/);
  assert.match(out, /ZULU-FOO/, 'snippet includes indexed content');
});

test('per-user isolation: user B does not see user A chunks', { concurrency: false }, async () => {
  const a = seedUser();
  const b = seedUser();
  const sa = seedSession(a);
  const sb = seedSession(b);
  const ma = seedMessage(sa, a, 'Specific phrase: ALPHA-FOO project layout');
  const mb = seedMessage(sb, b, 'Specific phrase: BETA-FOO different topic');
  await rag.indexSource({ kind: 'user_message', id: ma, content: 'Specific phrase: ALPHA-FOO project layout', sessionId: sa });
  await rag.indexSource({ kind: 'user_message', id: mb, content: 'Specific phrase: BETA-FOO different topic', sessionId: sb });

  // User A asks about their own content.
  const aQuery = seedSession(a);
  const aOut = await renderRecalledContextBlock(a, 'Specific phrase ALPHA-FOO project layout', aQuery);
  assert.match(aOut, /ALPHA-FOO/);
  assert.ok(!aOut.includes('BETA-FOO'), 'A must not see B content');

  // User B asks about their own content.
  const bQuery = seedSession(b);
  const bOut = await renderRecalledContextBlock(b, 'Specific phrase BETA-FOO different topic', bQuery);
  assert.match(bOut, /BETA-FOO/);
  assert.ok(!bOut.includes('ALPHA-FOO'), 'B must not see A content');
});

test('session exclusion: current session chunks are filtered out', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  const content = 'Specific phrase: GAMMA-FOO only-in-this-session';
  const mid = seedMessage(sessionId, userId, content);
  await rag.indexSource({ kind: 'user_message', id: mid, content, sessionId });

  // Query with the SAME sessionId — current session, should be filtered.
  const out = await renderRecalledContextBlock(userId, 'GAMMA-FOO only-in-this-session', sessionId);
  assert.equal(out, '', 'cross-session only — same session excluded');

  // Without sessionId (or with a different one) — should be included.
  const otherSession = seedSession(userId);
  const out2 = await renderRecalledContextBlock(userId, 'GAMMA-FOO only-in-this-session', otherSession);
  assert.match(out2, /GAMMA-FOO/);
});

test('block format: <system> wrapper + bullet list + </system>', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  const mid = seedMessage(sessionId, userId, 'Test content DELTA-FOO for format check');
  await rag.indexSource({ kind: 'user_message', id: mid, content: 'Test content DELTA-FOO for format check', sessionId });

  const otherSession = seedSession(userId);
  const out = await renderRecalledContextBlock(userId, 'Test content DELTA-FOO', otherSession);
  assert.match(out, /^<system>\nRecalled context from your past chats \(most relevant first\):\n/);
  assert.match(out, /\n<\/system>$/);
  assert.match(out, /^- \(past-message\) /m, 'bullet list with past-message label');
});

test('snippet cap at RECALLED_SNIPPET_MAX chars', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  const long = 'X'.repeat(_internals.RECALLED_SNIPPET_MAX + 200);
  const mid = seedMessage(sessionId, userId, `EPSILON-FOO ${long}`);
  await rag.indexSource({ kind: 'user_message', id: mid, content: `EPSILON-FOO ${long}`, sessionId });
  const otherSession = seedSession(userId);
  const out = await renderRecalledContextBlock(userId, 'EPSILON-FOO XXXXXXX', otherSession);
  // The snippet is sliced at RECALLED_SNIPPET_MAX.
  const m = out.match(/\(past-message\) (.+?)\n/);
  assert.ok(m);
  assert.ok(m[1].length <= _internals.RECALLED_SNIPPET_MAX, 'snippet within cap');
});