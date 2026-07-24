/**
 * Extractor-worker tests — real DB, mocked LLM. Validates the idle-loop
 * scheduler + per-user opt-out + idempotency.
 *
 * Setup: each test gets two users + sessions in known idle states.
 * LLM is stubbed via _setExtractorLLMForTests to a fixed response.
 *
 * Coverage:
 *  1. Session older than idle threshold + no prior extraction → runs extractor
 *  2. Session within idle window → skipped
 *  3. Session already extracted since last activity → skipped (idempotent)
 *  4. User with auto_memory_enabled=0 → skipped even if idle
 *  5. Only user-side (no assistant turn) → skipped
 *  6. After extraction, second run on same idle window is no-op
 *  7. Embed session (owner_type='tenant') → skipped (not platform user's)
 *  8. User with no user_settings row → defaults to ON
 *
 * Run: node --test src/extractor-worker.test.js
 */

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const db = (await import("./db/index.js")).default;
const {
  startExtractorWorker,
  stopExtractorWorker,
  runOnce,
} = await import("./extractor-worker.js");
const {
  listFacts,
} = await import("./memory.js");
const {
  _setExtractorLLMForTests,
  _resetExtractorLLMForTests,
} = await import("./extractor.js");

const seededUserIds = [];
const seededSessionIds = [];

function seedUser(name) {
  const id = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`
    )
    .run(name, name).lastInsertRowid;
  seededUserIds.push(Number(id));
  return Number(id);
}

function seedSession({ userId, ageMs, lastExtractedAt = null, ownerType = "user" }) {
  // Make a session with `id` we control + per-test updated_at / last_memory_extracted_at.
  // IMPORTANT: use SQLite's `YYYY-MM-DD HH:MM:SS` format. ISO 8601 with
  // 'T' and 'Z' won't compare against `datetime('now', '-300 seconds')`
  // — SQLite stores the literal string and the comparison fails.
  const fmt = (msAgo) => {
    const d = new Date(Date.now() - msAgo);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const updatedAt = fmt(ageMs);
  const extractedAt = lastExtractedAt != null ? fmt(lastExtractedAt) : null;
  const info = db
    .prepare(
      `INSERT INTO sessions (title, model, user_id, owner_type, owner_id, updated_at, last_memory_extracted_at)
       VALUES (?, 'workspace', ?, ?, ?, ?, ?)`
    )
    .run(
      `sess-${crypto.randomBytes(3).toString("hex")}`,
      userId,
      ownerType,
      String(userId),
      updatedAt,
      extractedAt
    );
  seededSessionIds.push(Number(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}

function seedMessage(sessionId, role, content) {
  db.prepare(
    `INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`
  ).run(sessionId, role, content);
}

let aliceId;
let bobId;

before(() => {
  aliceId = seedUser("alice-extw");
  bobId = seedUser("bob-extw");
});

beforeEach(() => {
  // Default mock so a stray LLM call returns no facts.
  _setExtractorLLMForTests(async () => '{"facts":[]}');
  // Wipe sessions + messages + facts + settings for the test users so
  // each test starts from a known idle/idle-extracted state. Without
  // this, the per-test WHERE filter may skip seeded sessions that the
  // previous test's runOnce has already stamped with
  // last_memory_extracted_at — making the count assertion unreliable.
  for (const sid of seededSessionIds.splice(0)) {
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  db.prepare(`DELETE FROM user_settings WHERE user_id IN (?, ?)`).run(aliceId, bobId);
  db.prepare(`DELETE FROM user_memory_facts WHERE user_id IN (?, ?)`).run(aliceId, bobId);
});

after(() => {
  stopExtractorWorker();
  // Cleanup rows in dependency order.
  for (const sid of seededSessionIds) {
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  }
  for (const uid of seededUserIds) {
    db.prepare(`DELETE FROM user_memory_facts WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);
  }
  _resetExtractorLLMForTests();
});

// Default IDLE threshold is 5 min. Use 10 min as 'idle' so we don't fight
// the system clock in the SQL `datetime('now', -X seconds)` filter.

test("idle session without prior extraction → facts extracted + last_extracted bumped", async () => {
  _setExtractorLLMForTests(async () =>
    JSON.stringify({ facts: [{ key: "lokasi", value: "Bandung" }] })
  );
  const sid = seedSession({ userId: aliceId, ageMs: 10 * 60_000 });
  seedMessage(sid, "user", "Saya tinggal di Bandung");
  seedMessage(sid, "assistant", "Siap, Bandung ya.");

  await runOnce();
  const facts = listFacts(aliceId);
  assert.equal(facts.length, 1, "fact written");
  assert.equal(facts[0].key, "lokasi");
  assert.equal(facts[0].value, "Bandung");
  assert.equal(facts[0].source, "auto");
  const sess = db.prepare(`SELECT last_memory_extracted_at FROM sessions WHERE id = ?`).get(sid);
  assert.ok(sess.last_memory_extracted_at, "last_memory_extracted_at bumped");
});

test("session within idle window → skipped", async () => {
  const sid = seedSession({ userId: aliceId, ageMs: 30_000 }); // 30s — under threshold
  seedMessage(sid, "user", "x");
  seedMessage(sid, "assistant", "y");
  // LLM would write a fact if invoked.
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "should_not_appear", value: "x" }] }));
  await runOnce();
  assert.equal(listFacts(aliceId).length, 0);
});

test("session already extracted since last activity → skipped (idempotent)", async () => {
  const sid = seedSession({
    userId: aliceId,
    ageMs: 10 * 60_000,                    // idle
    lastExtractedAt: 1_000,                // bumped just 1s ago
  });
  seedMessage(sid, "user", "x");
  seedMessage(sid, "assistant", "y");
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "should_not_appear", value: "x" }] }));
  await runOnce();
  assert.equal(listFacts(aliceId).length, 0);
});

test("user opted out (auto_memory_enabled=0) → skipped even if idle", async () => {
  db.prepare(`INSERT INTO user_settings (user_id, auto_memory_enabled) VALUES (?, 0)`).run(aliceId);
  const sid = seedSession({ userId: aliceId, ageMs: 10 * 60_000 });
  seedMessage(sid, "user", "x");
  seedMessage(sid, "assistant", "y");
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "lokasi", value: "x" }] }));
  await runOnce();
  assert.equal(listFacts(aliceId).length, 0);
});

test("user with no settings row → defaults to ON", async () => {
  const sid = seedSession({ userId: bobId, ageMs: 10 * 60_000 });
  seedMessage(sid, "user", "x");
  seedMessage(sid, "assistant", "y");
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "role", value: "engineer" }] }));
  await runOnce();
  const facts = listFacts(bobId);
  assert.equal(facts.length, 1, "default-ON extraction ran");
});

test("only user-side messages → skipped", async () => {
  const sid = seedSession({ userId: aliceId, ageMs: 10 * 60_000 });
  seedMessage(sid, "user", "Pertanyaan tanpa jawaban");
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "lokasi", value: "x" }] }));
  await runOnce();
  assert.equal(listFacts(aliceId).length, 0);
});

test("after extraction, second run on same idle window is no-op", async () => {
  _setExtractorLLMForTests(async () =>
    JSON.stringify({ facts: [{ key: "lokasi", value: "Bandung" }] })
  );
  const sid = seedSession({ userId: aliceId, ageMs: 10 * 60_000 });
  seedMessage(sid, "user", "Saya tinggal di Bandung");
  seedMessage(sid, "assistant", "OK");

  await runOnce();
  assert.equal(listFacts(aliceId).length, 1);

  // Second tick: same idle window, last_memory_extracted_at now > updated_at
  // (we just bumped it), so the WHERE clause excludes this session.
  await runOnce();
  assert.equal(listFacts(aliceId).length, 1, "still 1, no double-write");
});

test("embed session (owner_type='tenant') → skipped (not platform user)", async () => {
  const sid = seedSession({
    userId: aliceId,            // user id still points to alice (embed sessions have owner_id set to tenant uuid in real usage; here we keep it simple)
    ageMs: 10 * 60_000,
    ownerType: "tenant",
  });
  seedMessage(sid, "user", "Saya tinggal di Bandung");
  seedMessage(sid, "assistant", "OK");
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: [{ key: "lokasi", value: "Bandung" }] }));
  await runOnce();
  assert.equal(listFacts(aliceId).length, 0, "embed session ignored");
});

test("startExtractorWorker / stopExtractorWorker are idempotent", () => {
  startExtractorWorker();
  startExtractorWorker(); // should be no-op (singleton)
  stopExtractorWorker();
  stopExtractorWorker();
});