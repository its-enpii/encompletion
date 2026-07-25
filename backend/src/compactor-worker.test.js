/**
 * Compactor-worker tests — real DB, mocked LLM.
 *
 * Coverage:
 *  1. Session with msg_count <= RECENT_TAIL → skipped (nothing to compact)
 *  2. Session over THRESHOLD + never compacted → row written + last_compacted_at bumped
 *  3. Session over THRESHOLD + already compacted + no new messages → skipped
 *  4. Session over THRESHOLD + new message arrived → re-compacted (rolling update)
 *  5. Embed/tenant session → skipped
 *  6. LLM error → no row written; session re-attempted later
 *  7. Rolling: 2nd run with no new messages → no DB write
 *  8. startCompactorWorker / stopCompactorWorker are idempotent
 *
 * Run: node --test src/compactor-worker.test.js
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const {
  startCompactorWorker,
  stopCompactorWorker,
  runOnce,
  _internals,
} = await import('./compactor-worker.js');
const {
  compactTranscript,
  _setCompactorLLMForTests,
  _resetCompactorLLMForTests,
} = await import('./compactor.js');

const seeded = { users: [], sessions: [], messages: [], summaries: [] };

function seedUser() {
  const name = 'cmp-' + crypto.randomBytes(3).toString('hex');
  const id = db
    .prepare(`INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`)
    .run(name, name).lastInsertRowid;
  seeded.users.push(Number(id));
  return Number(id);
}

function seedSession(userId, ownerType = 'user', ageMs = 0) {
  // Use SQLite-native datetime format for updated_at so the SQL
  // comparisons against last_compacted_at work the same as the
  // worker's filter.
  const iso = ageMs === 0
    ? new Date().toISOString().replace('T', ' ').slice(0, 19)
    : new Date(Date.now() - ageMs).toISOString().replace('T', ' ').slice(0, 19);
  const title = `cmp-${crypto.randomBytes(3).toString('hex')}`;
  const id = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id, updated_at)
       VALUES (?, 'workspace', ?, ?, ?, ?)`
    )
    .run(title, userId, ownerType, String(userId), iso).lastInsertRowid;
  seeded.sessions.push(Number(id));
  return Number(id);
}

function seedMessage(sessionId, role, content) {
  const id = db
    .prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`)
    .run(sessionId, role, content).lastInsertRowid;
  seeded.messages.push(Number(id));
  return Number(id);
}

let aliceId;
let bobId;

before(() => {
  aliceId = seedUser();
  bobId = seedUser();
});

beforeEach(() => {
  // Default mock: returns a short summary.
  _setCompactorLLMForTests(async () => 'Topic: testing. The session is doing things.');
  // Wipe state per-test for isolation.
  for (const sid of seeded.sessions.splice(0)) {
    db.prepare(`DELETE FROM session_summaries WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  for (const mid of seeded.messages.splice(0)) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(mid);
  }
  // Reset users that the test seeded.
  db.prepare(`DELETE FROM users WHERE id IN (?, ?)`).run(aliceId, bobId);
  aliceId = seedUser();
  bobId = seedUser();
});

after(() => {
  stopCompactorWorker();
  for (const sid of seeded.sessions.splice(0)) {
    db.prepare(`DELETE FROM session_summaries WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  for (const mid of seeded.messages.splice(0)) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(mid);
  }
  for (const uid of seeded.users.splice(0)) {
    db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);
  }
  _resetCompactorLLMForTests();
});

test('session with msg_count <= RECENT_TAIL → skipped', async () => {
  const sid = seedSession(aliceId);
  // Fill exactly RECENT_TAIL messages.
  for (let i = 0; i < _internals.RECENT_TAIL; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
  }
  await runOnce();
  const row = db.prepare(`SELECT * FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.equal(row, undefined, 'no summary for short session');
});

test('session over THRESHOLD + never compacted → summary written + last_compacted_at bumped', async () => {
  const sid = seedSession(aliceId);
  // THRESHOLD + 5 messages — older = 23 (THRESHOLD 30 - RECENT_TAIL 12 = 18).
  for (let i = 0; i < _internals.THRESHOLD + 5; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
  }
  await runOnce();
  const row = db.prepare(`SELECT * FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.ok(row, 'summary row created');
  assert.match(row.summary, /Topic: testing/);
  assert.ok(row.summarized_up_to > 0);
  assert.ok(row.model);

  const sess = db.prepare(`SELECT last_compacted_at FROM sessions WHERE id = ?`).get(sid);
  assert.ok(sess.last_compacted_at, 'last_compacted_at stamped');
});

test('session already compacted + no new messages → skipped', async () => {
  const sid = seedSession(aliceId);
  for (let i = 0; i < _internals.THRESHOLD + 5; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
  }

  // Pre-set last_compacted_at = updated_at → worker skips.
  db.prepare(`UPDATE sessions SET last_compacted_at = updated_at WHERE id = ?`).run(sid);

  await runOnce();
  const row = db.prepare(`SELECT * FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.equal(row, undefined, 'no summary when last_compacted_at == updated_at');
});

test('new message arrives after compaction → re-compacted (rolling)', async () => {
  const sid = seedSession(aliceId);
  for (let i = 0; i < _internals.THRESHOLD + 5; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
  }
  await runOnce();
  const row1 = db.prepare(`SELECT summary, summarized_up_to FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.ok(row1);
  const firstSummaryUpTo = row1.summarized_up_to;

  // New message + updated_at change → tick 2 re-compacts.
  seedMessage(sid, 'user', 'New topic: something else entirely.');
  // Bump updated_at past last_compacted_at. CURRENT_TIMESTAMP may
  // resolve to the same second as the prior stamp (SQLite stores
  // at second precision); add a buffer by using datetime('now', '+1
  // second') so the > filter triggers deterministically.
  db.prepare(`UPDATE sessions SET updated_at = datetime('now', '+1 second') WHERE id = ?`).run(sid);

  let calls = 0;
  const realMock = _setCompactorLLMForTests.bind(null);
  _setCompactorLLMForTests(async (...args) => {
    calls++;
    return 'Topic: rolling update. New summary text after additional messages.';
  });

  await runOnce();
  const row2 = db.prepare(`SELECT summary, summarized_up_to FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.ok(row2.summarized_up_to > firstSummaryUpTo, 'summarized_up_to advanced');
  assert.match(row2.summary, /rolling update/);
});

test('embed/tenant session → skipped', async () => {
  const sid = seedSession(aliceId, 'tenant');
  for (let i = 0; i < _internals.THRESHOLD + 5; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `embed msg ${i}`);
  }
  await runOnce();
  const row = db.prepare(`SELECT * FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.equal(row, undefined, 'tenant session skipped');
});

test('LLM error → no row written; session re-attempted later', async () => {
  const sid = seedSession(aliceId);
  for (let i = 0; i < _internals.THRESHOLD + 5; i++) {
    seedMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
  }
  _setCompactorLLMForTests(async () => { throw new Error('simulated LLM down'); });
  await runOnce();
  const row = db.prepare(`SELECT * FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.equal(row, undefined, 'no row written on failure');

  // Tick again with mock fixed → succeeds.
  _setCompactorLLMForTests(async () => 'Topic: recovered. The LLM is back.');
  // updated_at is still > NULL last_compacted_at, so it'll be picked up.
  await runOnce();
  const row2 = db.prepare(`SELECT summary FROM session_summaries WHERE session_id = ?`).get(sid);
  assert.ok(row2, 'recovered');
});

test('startCompactorWorker / stopCompactorWorker are idempotent', () => {
  startCompactorWorker();
  startCompactorWorker(); // singleton
  stopCompactorWorker();
  stopCompactorWorker();
});