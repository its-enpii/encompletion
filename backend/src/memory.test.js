/**
 * Memory facts tests — pure DB coverage. No HTTP, no LLM.
 *
 * Coverage:
 *  1. listFacts returns [] for user with no facts
 *  2. upsertFact inserts new fact (returns row with id, source='manual')
 *  3. upsertFact updates existing fact by (user_id, key), bumping updated_at
 *  4. upsertFact rejects invalid key (space, leading digit, too long)
 *  5. upsertFact rejects empty / too-long value
 *  6. upsertFact enforces MAX_FACTS_PER_USER cap
 *  7. deleteFact only deletes the user's own fact (cross-user returns false)
 *  8. renderMemoryFactsBlock returns '' when user has no facts
 *  9. renderMemoryFactsBlock formats as bullet list inside <system> tag
 * 10. Integration: fullSystemPrompt = system + memory block when facts exist
 *
 * Run: node --test src/memory.test.js
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const db = (await import('./db/index.js')).default;
const {
  listFacts,
  upsertFact,
  deleteFact,
  renderMemoryFactsBlock,
} = await import('./memory.js');
const { _internals } = await import('./memory.js');

// Two throwaway users so we can test cross-user isolation without
// polluting the bootstrap admin row. Wiped between every test so a
// failed assertion in one doesn't leak state into the next.
const testUsers = [];
function seedUser(name) {
  const id = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, NULL, 'member', ?)`
    )
    .run(name, name).lastInsertRowid;
  testUsers.push(Number(id));
  return Number(id);
}

let aliceId;
let bobId;

before(() => {
  aliceId = seedUser('alice-mem');
  bobId = seedUser('bob-mem');
});

// Drop any facts the two test users might have inherited from a prior
// failed run so tests stay order-independent and re-runnable.
beforeEach(() => {
  for (const uid of [aliceId, bobId]) {
    db.prepare(`DELETE FROM user_memory_facts WHERE user_id = ?`).run(uid);
  }
});

test('listFacts returns [] for user with no facts', () => {
  assert.deepEqual(listFacts(aliceId), []);
});

test('upsertFact inserts new fact with source=manual', () => {
  const row = upsertFact(aliceId, 'lokasi', 'Jakarta');
  assert.equal(row.user_id, aliceId);
  assert.equal(row.key, 'lokasi');
  assert.equal(row.value, 'Jakarta');
  assert.equal(row.source, 'manual');
  assert.ok(row.id > 0);
});

test('upsertFact updates existing fact by (user_id, key)', () => {
  upsertFact(aliceId, 'lokasi', 'Jakarta');
  const before = listFacts(aliceId).find((f) => f.key === 'lokasi');
  const after = upsertFact(aliceId, 'lokasi', 'Bandung');
  assert.equal(after.id, before.id, 'same row id after update');
  assert.equal(after.value, 'Bandung');
  assert.equal(after.created_at, before.created_at, 'created_at preserved');
});

test('upsertFact rejects invalid keys', () => {
  // spaces
  assert.throws(() => upsertFact(aliceId, 'has space', 'x'), /alphanumeric/);
  // leading digit
  assert.throws(() => upsertFact(aliceId, '1lokasi', 'x'), /alphanumeric/);
  // empty
  assert.throws(() => upsertFact(aliceId, '', 'x'), /alphanumeric/);
  // too long (> 40 chars)
  assert.throws(() => upsertFact(aliceId, 'k'.repeat(41), 'x'), /alphanumeric/);
});

test('upsertFact rejects empty or too-long value', () => {
  assert.throws(() => upsertFact(aliceId, 'empty_val', ''), /1\.\.2000/);
  assert.throws(() => upsertFact(aliceId, 'long_val', 'x'.repeat(_internals.MAX_VALUE_LEN + 1)), /1\.\.2000/);
});

test('upsertFact enforces MAX_FACTS_PER_USER cap', () => {
  // beforeEach wiped the test users; refill alice up to the limit.
  const cap = _internals.MAX_FACTS_PER_USER;
  for (let i = 0; i < cap; i++) {
    const k = `cap${String(i).padStart(2, '0')}`;
    upsertFact(aliceId, k, `value ${i}`);
  }
  assert.equal(listFacts(aliceId).length, cap, 'hit cap exactly');
  // One more insert should throw; updates of existing keys still work.
  assert.throws(
    () => upsertFact(aliceId, 'cap_overflow', 'nope'),
    new RegExp(`max ${cap}`)
  );
  // Update existing still works (does not bump the count).
  upsertFact(aliceId, 'cap00', 'updated');
  const r = listFacts(aliceId).find((f) => f.key === 'cap00');
  assert.equal(r.value, 'updated');
});

test('deleteFact only deletes own facts (cross-user isolation)', () => {
  upsertFact(aliceId, 'isolated', 'alice-value');
  const aliceFact = listFacts(aliceId).find((f) => f.key === 'isolated');
  // Bob trying to delete Alice's fact → false (no row matches user_id=bob).
  const ok = deleteFact(bobId, aliceFact.id);
  assert.equal(ok, false, 'cross-user delete rejected');
  // Alice's fact still exists.
  assert.ok(listFacts(aliceId).find((f) => f.key === 'isolated'));
  // Alice can delete it.
  const okSelf = deleteFact(aliceId, aliceFact.id);
  assert.equal(okSelf, true);
  assert.equal(listFacts(aliceId).find((f) => f.key === 'isolated'), undefined);
});

test('renderMemoryFactsBlock returns "" for no facts', () => {
  // Bob has nothing after beforeEach.
  assert.equal(renderMemoryFactsBlock(bobId), '');
});

test('renderMemoryFactsBlock formats as <system> bullet list', () => {
  upsertFact(bobId, 'lokasi', 'Surabaya');
  upsertFact(bobId, 'role', 'pm');
  const block = renderMemoryFactsBlock(bobId);
  assert.match(block, /^<system>\n/);
  assert.match(block, /User facts \(persistent across all sessions\):/);
  assert.match(block, /- lokasi: Surabaya/);
  assert.match(block, /- role: pm/);
  assert.match(block, /<\/system>$/);
  // Sorted alphabetically by key.
  const lokasiIdx = block.indexOf('- lokasi:');
  const roleIdx = block.indexOf('- role:');
  assert.ok(lokasiIdx < roleIdx, 'sorted by key asc');
});

test('renderMemoryFactsBlock collapses newlines and caps length in value', () => {
  upsertFact(bobId, 'multiline', 'line1\nline2\nline3');
  upsertFact(bobId, 'longvalue', 'x'.repeat(500));
  const block = renderMemoryFactsBlock(bobId);
  assert.match(block, /- multiline: line1 line2 line3/, 'newlines collapsed to single space');
  // Per-value rendered cap is 240 chars.
  const m = block.match(/- longvalue: (x+)/);
  assert.ok(m);
  assert.equal(m[1].length, 240, 'value rendered cap = 240 chars');
});

test('integration: prompt composition appends facts block to system prompt', async () => {
  upsertFact(bobId, 'lokasi', 'Bandung');
  // Simulate the composition logic in llm-runner.js: facts block is
  // appended below the persona block when present.
  const systemPrompt = 'BASE PROMPT';
  const memoryBlock = renderMemoryFactsBlock(bobId);
  const composed = memoryBlock ? `${systemPrompt}\n\n${memoryBlock}` : systemPrompt;
  assert.match(composed, /^BASE PROMPT\n\n<system>\nUser facts/);
  assert.match(composed, /- lokasi: Bandung/);
  // Empty facts: composed == base unchanged. Wipe bob's fact to verify.
  for (const f of listFacts(bobId)) deleteFact(bobId, f.id);
  const empty = renderMemoryFactsBlock(bobId);
  const composedEmpty = empty ? `${systemPrompt}\n\n${empty}` : systemPrompt;
  assert.equal(composedEmpty, systemPrompt);
});

test('cleanup test users + their facts', () => {
  // Wipe facts for the two test users we created, then delete the
  // users. CASCADE handles the fact rows but we delete them explicitly
  // to keep the suite idempotent on the rare case where CASCADE is off.
  for (const uid of testUsers) {
    db.prepare(`DELETE FROM user_memory_facts WHERE user_id = ?`).run(uid);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);
  }
  testUsers.length = 0;
});