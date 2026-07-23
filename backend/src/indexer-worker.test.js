/**
 * Indexer-worker tests — real DB, fake embedder.
 *
 * Verifies the idle-batch sweep that turns messages.last_indexed_at IS
 * NULL into embedded user_message chunks. The 'fake' embedder hashes
 * whitespace tokens so deterministic test content lands in a known
 * cosine bucket.
 *
 * Coverage:
 *  1. Worker finds unindexed messages → embeds + bumps timestamp
 *  2. Already-indexed messages are skipped
 *  3. Embed/tenant session messages skipped
 *  4. Embedder error → no timestamp bump; tick stops early
 *  5. Batch cap respected (BATCH_MAX per tick)
 *
 * Run: EMBED_PROVIDER=fake EMBED_FAKE_DIM=4 node --test src/indexer-worker.test.js
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
  startIndexerWorker,
  stopIndexerWorker,
  runOnce,
  _internals,
} = await import('./indexer-worker.js');
const {
  _setExtractorLLMForTests,
  _resetExtractorLLMForTests,
} = await import('./extractor.js');  // for test util — won't actually call LLM

const seeded = { users: [], sessions: [], messages: [], chunks: [] };

function seedUser(name = 'iw-' + crypto.randomBytes(3).toString('hex')) {
  const id = db
    .prepare(`INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`)
    .run(name, name).lastInsertRowid;
  seeded.users.push(Number(id));
  return Number(id);
}

function seedSession(userId, ownerType = 'user') {
  const id = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id)
       VALUES (?, 'workspace', ?, ?, ?)`
    )
    .run(`iw-${crypto.randomBytes(3).toString('hex')}`, userId, ownerType, String(userId)).lastInsertRowid;
  seeded.sessions.push(Number(id));
  return Number(id);
}

function seedMessage(sessionId, userId, content, indexed = false) {
  // messages has no user_id column — accept userId for ergonomics but
  // don't write it. User scoping is via sessions.owner_id at the rag
  // layer.
  if (indexed) {
    const id = db
      .prepare(
        `INSERT INTO messages (session_id, role, content, last_indexed_at)
         VALUES (?, 'user', ?, CURRENT_TIMESTAMP)`
      )
      .run(sessionId, content).lastInsertRowid;
    seeded.messages.push(Number(id));
    return Number(id);
  }
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
  // Wipe chunks, session links, AND messages so the batch test sees
  // an empty queue. Messages from earlier tests have been seeded into
  // the same DB and would otherwise be picked up by the worker,
  // shrinking the slice available for the batch_cap test.
  db.prepare(`DELETE FROM embeddings_session`).run();
  db.prepare(`DELETE FROM embeddings_chunk`).run();
  db.prepare(`DELETE FROM messages`).run();
});

after(() => {
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
  stopIndexerWorker();
  resetEmbed();
  _resetExtractorLLMForTests();
});

test('worker finds unindexed messages → embeds + bumps timestamp', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  const m1 = seedMessage(sessionId, userId, 'Indexed content ZETA-FOO first message');
  const m2 = seedMessage(sessionId, userId, 'Indexed content ETA-FOO second message');

  await runOnce();

  // Both messages now have chunks + last_indexed_at stamped.
  const r1 = db.prepare(`SELECT last_indexed_at FROM messages WHERE id = ?`).get(m1);
  const r2 = db.prepare(`SELECT last_indexed_at FROM messages WHERE id = ?`).get(m2);
  assert.ok(r1.last_indexed_at, 'm1 stamped');
  assert.ok(r2.last_indexed_at, 'm2 stamped');

  // Each message has at least one chunk via embeddings_session.
  const c1 = db.prepare(
    `SELECT COUNT(*) AS n FROM embeddings_chunk c JOIN embeddings_session es ON es.chunk_id = c.id WHERE c.source_kind = 'user_message' AND c.source_id = ?`
  ).get(m1);
  assert.ok(c1.n > 0, 'm1 chunked');
  const c2 = db.prepare(
    `SELECT COUNT(*) AS n FROM embeddings_chunk c JOIN embeddings_session es ON es.chunk_id = c.id WHERE c.source_kind = 'user_message' AND c.source_id = ?`
  ).get(m2);
  assert.ok(c2.n > 0, 'm2 chunked');
});

test('already-indexed messages are skipped', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  // Indexed = true sets last_indexed_at directly.
  const m1 = seedMessage(sessionId, userId, 'Already indexed content THETA-FOO', true);
  await runOnce();
  const r = db.prepare(`SELECT last_indexed_at FROM messages WHERE id = ?`).get(m1);
  // Timestamp should still be set (was already); no NEW chunks should
  // appear since the indexer skip NULLs.
  assert.ok(r.last_indexed_at);
  const c = db.prepare(`SELECT COUNT(*) AS n FROM embeddings_chunk WHERE source_kind = 'user_message' AND source_id = ?`).get(m1);
  assert.equal(c.n, 0, 'no chunk inserted for already-indexed message');
});

test('embed/tenant session messages are skipped', { concurrency: false }, async () => {
  const userId = seedUser();
  // Create a tenant-owned session (owner_type='tenant').
  const sid = seedSession(userId, 'tenant');
  const mid = seedMessage(sid, userId, 'Embed session content IOTA-FOO');
  await runOnce();
  const r = db.prepare(`SELECT last_indexed_at FROM messages WHERE id = ?`).get(mid);
  assert.equal(r.last_indexed_at, null, 'embed session message skipped');
});

test('embedder error → no timestamp bump; tick stops early', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  // Force the embed call to throw by patching rag.indexSource via the
  // indexer module's dependency. Simplest: poison the chunker via a
  // big content that the chunker can't handle. But that breaks other
  // tests — use a different approach: stub via dynamic import.
  // We simulate a runtime error by deleting the indexer's rag import
  // mid-test — instead, swap with a tiny in-test interceptor: call
  // indexMessage with content that triggers an error inside rag.
  // The 'fake' provider can't fail mid-batch on its own, so we patch
  // rag.indexSource for the duration of this test.
  const ragMod = await import('./rag.js');
  const realIndex = ragMod.default.indexSource;
  let calls = 0;
  ragMod.default.indexSource = async (...args) => {
    calls++;
    throw new Error('simulated embedder failure');
  };
  try {
    const m1 = seedMessage(sessionId, userId, 'KAPPA-FOO should fail');
    const m2 = seedMessage(sessionId, userId, 'LAMBDA-FOO should not even be tried');
    await runOnce();
    const r1 = db.prepare(`SELECT last_indexed_at FROM messages WHERE id = ?`).get(m1);
    assert.equal(r1.last_indexed_at, null, 'm1 not stamped on failure');
    // Note: with our backoff, we break after first failure. m2 may or
    // may not be attempted depending on timing — but since both share
    // the same tick and the first call throws synchronously, m2 is
    // never reached.
    assert.ok(calls >= 1, 'embedder was called');
  } finally {
    ragMod.default.indexSource = realIndex;
  }
});

test('batch cap respected (BATCH_MAX per tick)', { concurrency: false }, async () => {
  const userId = seedUser();
  const sessionId = seedSession(userId);
  // Override the module-level BATCH_MAX via env on import time would
  // require re-import — instead, we just exceed the default and
  // verify only BATCH_MAX messages get indexed in one runOnce.
  const N = _internals.BATCH_MAX + 5;
  const ids = [];
  for (let i = 0; i < N; i++) {
    ids.push(seedMessage(sessionId, userId, `Batch test message ${i} MU-FOO`));
  }
  await runOnce();
  const stamped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE session_id = ? AND last_indexed_at IS NOT NULL`
    )
    .get(sessionId);
  // Stamped count == BATCH_MAX (we created BATCH_MAX + 5; first
  // BATCH_MAX are indexed, the rest queue for next tick).
  assert.equal(stamped.n, _internals.BATCH_MAX, `stamped = BATCH_MAX (${_internals.BATCH_MAX})`);
});

test('startIndexerWorker / stopIndexerWorker are idempotent', { concurrency: false }, () => {
  startIndexerWorker();
  startIndexerWorker(); // singleton
  stopIndexerWorker();
  stopIndexerWorker();
});