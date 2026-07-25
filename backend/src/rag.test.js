/**
 * RAG smoke test. Uses EMBED_PROVIDER=fake so no model download is
 * required and dim is controllable per run. Tests run in-process and
 * mutate the module's `activeDim` state — keep them in sequence.
 *
 * Run: EMBED_PROVIDER=fake EMBED_FAKE_DIM=4 node --test src/rag.test.js
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.EMBED_PROVIDER = 'fake';
process.env.EMBED_FAKE_DIM = '4';

const { embed, _resetForTests: resetEmbed } = await import('./embedder.js');
const rag = (await import('./rag.js')).default;
const { default: db } = await import('./db/index.js');

let counter = 0;
function newSourceId() {
  // Random positive 64-bit-ish integer; no need to round-trip the DB.
  counter += 1;
  return Date.now() * 1000 + counter;
}

function newSessionId() {
  // We need a real row in `sessions` because embeddings_session has
  // a FK on it. The simplest path is to create one owned by the dev
  // admin user, then drop it at end-of-test.
  let admin = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
  if (!admin) {
    const r = db.prepare(
      `INSERT INTO users (username, role) VALUES ('admin', 'admin')`
    ).run();
    admin = { id: r.lastInsertRowid };
  }
  const ins = db.prepare(
    `INSERT INTO sessions (title, model, user_id) VALUES ('__rag_test__', 'workspace', ?)`
  ).run(admin.id);
  return ins.lastInsertRowid;
}

function dropSession(id) {
  try { rag.removeSession(id); } catch {}
  db.prepare(`DELETE FROM embeddings_session WHERE session_id = ?`).run(id);
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

before(async () => {
  await embed(['warmup']);
});

test('index/query round-trip with project_knowledge', { concurrency: false }, async () => {
  const id = newSourceId();
  await rag.indexSource({
    kind: 'project_knowledge',
    id,
    content: 'Apples are red. Bananas are yellow. Clouds are white.',
  });
  // No scopeUserId → all project_knowledge rows visible.
  const hits = await rag.query('what color is the sky?', { topK: 3 });
  assert.ok(hits.length > 0, 'expected at least one hit');
  assert.equal(hits[0].source_kind, 'project_knowledge');
  rag.removeSource('project_knowledge', id);
});

test('attachment is ephemeral per session', { concurrency: false }, async () => {
  const id = newSourceId();
  const sessionA = newSessionId();
  const sessionB = newSessionId();
  await rag.indexSource({
    kind: 'attachment',
    id,
    content: 'Specific session note: unique phrase XYZ-FOO.',
    sessionId: sessionA,
  });
  const own = await rag.query('XYZ-FOO', { topK: 3, sessionId: sessionA });
  assert.ok(own.length > 0, 'should see attachment in its own session');

  const other = await rag.query('XYZ-FOO', { topK: 3, sessionId: sessionB });
  assert.equal(other.length, 0, 'should NOT see attachment from another session');

  rag.removeSession(sessionA);
  const after = await rag.query('XYZ-FOO', { topK: 3, sessionId: sessionA });
  assert.equal(after.length, 0, 'removeSession should drop the chunks');
  dropSession(sessionA);
  dropSession(sessionB);
});

test('dim mismatch wipes the table', { concurrency: false }, async () => {
  // We can't swap providers mid-test (the embedder caches a single
  // provider instance). Instead, directly verify that the wipe path
  // produces a clean table when enforceDim sees a different incoming
  // dim — exercised via the public API by clearing activeDim and
  // inserting a pre-existing chunk with a non-matching dim, then
  // calling indexSource.
  //
  // The resetEmbed+rag._resetForTests calls below mimic a fresh boot
  // where the operator swapped providers: activeDim is null, the
  // first embed call returns the new dim (4), but enforceDim sees
  // that older rows have a different dim and wipes them before
  // accepting the new index.
  const idA = newSourceId();
  const idB = newSourceId();

  // First index with the current fake (4-dim) so we have a baseline.
  await rag.indexSource({ kind: 'project_knowledge', id: idA, content: 'baseline' });
  const baselineCount = db.prepare(`SELECT COUNT(*) AS n FROM embeddings_chunk`).get().n;
  assert.ok(baselineCount > 0);

  // Now pretend a 6-dim provider previously indexed some rows. Reset
  // activeDim so the next incoming dim is "fresh" and enforceDim runs.
  rag._resetForTests();
  const fakeBuf = Buffer.from(new Float32Array([1, 0, 0, 0, 0, 0]).buffer);
  db.prepare(
    `INSERT INTO embeddings_chunk (source_kind, source_id, chunk_index, content, vec, dim)
     VALUES (?, ?, 0, 'pre-existing-6d', ?, 6)`
  ).run('project_knowledge', idB, fakeBuf);

  // The current embedder returns 4-dim, so the next call returns dim=4.
  // activeDim was nulled out, so enforceDim accepts 4 and SETS activeDim=4
  // without wiping (activeDim is "null", incoming is "4" — no comparison).
  // To actually trigger the wipe path we need to assert enforceDim
  // behavior: a different dim from a *prior* incoming call should wipe.
  // We simulate this by re-asserting enforceDim directly through a
  // second indexSource with activeDim already set to 6 — but activeDim
  // is a module-level state we can't easily flip without exposing.
  //
  // Workaround: re-set activeDim to 6 via a second dim injection. The
  // module state is private; we patch by inserting more 6-dim rows
  // and adjusting activeDim via _setProviderLabelForTests + manual
  // trigger through indexSource's enforceDim path.
  //
  // Simplest robust test: verify the wipe SQL happens when we call
  // rag.query with a forced dim mismatch. The query() path also calls
  // enforceDim, so we exercise that branch:
  rag._resetForTests();
  // Manually set activeDim to 6 by inserting and reading through the
  // module's enforceDim path. Easiest: call query() which embeds with
  // the real provider (4-dim) and triggers enforceDim — but activeDim
  // is null so no wipe. The mismatch path only triggers if activeDim
  // is non-null AND differs from incoming. So set activeDim=6 via the
  // private helper we expose.
  rag._setActiveDimForTests(6);

  // Now query with 4-dim embedder → enforceDim sees 6 vs 4 → wipe.
  await rag.query('anything', { topK: 3 });
  const after = db.prepare(`SELECT COUNT(*) AS n, MIN(dim) AS m FROM embeddings_chunk`).get();
  assert.equal(after.n, 0, 'wipe should leave zero rows');
  assert.equal(after.m, null, 'wipe should leave zero rows');

  rag.removeSource('project_knowledge', idA);
  rag.removeSource('project_knowledge', idB);
});
