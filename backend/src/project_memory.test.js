/**
 * Project memory facts tests — pure DB coverage. No HTTP, no LLM.
 *
 * Mirrors memory.test.js (Phase 1) so the surface area is consistent:
 *  1. listProjectFacts returns [] for falsy projectId
 *  2. upsertProjectFact inserts new fact (returns row with id, source='manual')
 *  3. upsertProjectFact updates existing fact by (project_id, key)
 *  4. upsertProjectFact rejects invalid key
 *  5. upsertProjectFact rejects empty / too-long value
 *  6. upsertProjectFact enforces MAX_FACTS_PER_PROJECT cap
 *  7. deleteProjectFact only deletes own-project fact
 *  8. renderProjectMemoryFactsBlock returns '' for no facts
 *  9. renderProjectMemoryFactsBlock formats as <system> bullet list
 * 10. Long value sliced; newlines collapsed
 * 11. Integration: prompt composition slots block between user facts and recall
 *
 * Run: node --test src/project_memory.test.js
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const {
  listProjectFacts,
  upsertProjectFact,
  deleteProjectFact,
  renderProjectMemoryFactsBlock,
  _internals,
} = await import('./project_memory.js');

// Two throwaway projects so we can test cross-project isolation
// without polluting any real project row. Wiped between every test.
const seeded = { projects: [], facts: [] };
function seedProject() {
  // Need a project owner user_id for the FK. Create one per test
  // pair (alice for project A, bob for project B) so tests stay
  // independent.
  const userName = 'pm-' + crypto.randomBytes(3).toString('hex');
  const userId = db
    .prepare(`INSERT INTO users (username, password, role, display_name) VALUES (?, NULL, 'member', ?)`)
    .run(userName, userName).lastInsertRowid;
  const projectName = 'proj-' + crypto.randomBytes(3).toString('hex');
  const projectId = db
    .prepare(
      `INSERT INTO projects (user_id, name, owner_type, owner_id)
       VALUES (?, ?, 'user', ?)`
    )
    .run(userId, projectName, String(userId)).lastInsertRowid;
  seeded.projects.push({ projectId: Number(projectId), userId: Number(userId) });
  return Number(projectId);
}

let aliceProjectId;
let bobProjectId;

before(() => {
  aliceProjectId = seedProject();
  bobProjectId = seedProject();
});

beforeEach(() => {
  for (const p of [aliceProjectId, bobProjectId]) {
    db.prepare(`DELETE FROM project_memory_facts WHERE project_id = ?`).run(p);
  }
});

after(() => {
  for (const p of seeded.projects.splice(0)) {
    db.prepare(`DELETE FROM project_memory_facts WHERE project_id = ?`).run(p.projectId);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(p.projectId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(p.userId);
  }
});

test('listProjectFacts returns [] for falsy projectId', () => {
  assert.deepEqual(listProjectFacts(null), []);
  assert.deepEqual(listProjectFacts(undefined), []);
  assert.deepEqual(listProjectFacts(0), []);
});

test('upsertProjectFact inserts new fact with source=manual', () => {
  const row = upsertProjectFact(aliceProjectId, 'stack', 'Laravel 11');
  assert.equal(row.project_id, aliceProjectId);
  assert.equal(row.key, 'stack');
  assert.equal(row.value, 'Laravel 11');
  assert.equal(row.source, 'manual');
  assert.ok(row.id > 0);
});

test('upsertProjectFact updates existing fact by (project_id, key)', () => {
  upsertProjectFact(aliceProjectId, 'stack', 'Laravel 11');
  const before = listProjectFacts(aliceProjectId).find((f) => f.key === 'stack');
  const after = upsertProjectFact(aliceProjectId, 'stack', 'Laravel 12');
  assert.equal(after.id, before.id, 'same row id after update');
  assert.equal(after.value, 'Laravel 12');
  assert.equal(after.created_at, before.created_at, 'created_at preserved');
});

test('upsertProjectFact rejects invalid keys', () => {
  assert.throws(() => upsertProjectFact(aliceProjectId, 'has space', 'x'), /alphanumeric/);
  assert.throws(() => upsertProjectFact(aliceProjectId, '1stack', 'x'), /alphanumeric/);
  assert.throws(() => upsertProjectFact(aliceProjectId, '', 'x'), /alphanumeric/);
  assert.throws(() => upsertProjectFact(aliceProjectId, 'k'.repeat(41), 'x'), /alphanumeric/);
});

test('upsertProjectFact rejects empty or too-long value', () => {
  assert.throws(() => upsertProjectFact(aliceProjectId, 'empty_val', ''), /1\.\.2000/);
  assert.throws(
    () => upsertProjectFact(aliceProjectId, 'long_val', 'x'.repeat(_internals.MAX_VALUE_LEN + 1)),
    /1\.\.2000/
  );
});

test('upsertProjectFact enforces MAX_FACTS_PER_PROJECT cap', () => {
  const cap = _internals.MAX_FACTS_PER_PROJECT;
  for (let i = 0; i < cap; i++) {
    const k = `cap${String(i).padStart(2, '0')}`;
    upsertProjectFact(aliceProjectId, k, `value ${i}`);
  }
  assert.equal(listProjectFacts(aliceProjectId).length, cap, 'hit cap exactly');
  // One more insert → throw; updates of existing keys still work.
  assert.throws(
    () => upsertProjectFact(aliceProjectId, 'cap_overflow', 'nope'),
    new RegExp(`max ${cap}`)
  );
  // Update existing still works (does not bump the count).
  upsertProjectFact(aliceProjectId, 'cap00', 'updated');
  const r = listProjectFacts(aliceProjectId).find((f) => f.key === 'cap00');
  assert.equal(r.value, 'updated');
});

test('deleteProjectFact only deletes own-project facts (cross-project isolation)', () => {
  upsertProjectFact(aliceProjectId, 'isolated', 'alice-value');
  const aliceFact = listProjectFacts(aliceProjectId).find((f) => f.key === 'isolated');
  // Bob trying to delete Alice's fact via alice's project filter → false.
  const ok = deleteProjectFact(bobProjectId, aliceFact.id);
  assert.equal(ok, false, 'cross-project delete rejected');
  // Alice's fact still exists.
  assert.ok(listProjectFacts(aliceProjectId).find((f) => f.key === 'isolated'));
  // Alice can delete it.
  const okSelf = deleteProjectFact(aliceProjectId, aliceFact.id);
  assert.equal(okSelf, true);
  assert.equal(listProjectFacts(aliceProjectId).find((f) => f.key === 'isolated'), undefined);
});

test('renderProjectMemoryFactsBlock returns "" for no facts', () => {
  // Bob's project has no facts after beforeEach.
  assert.equal(renderProjectMemoryFactsBlock(bobProjectId), '');
  // Falsy projectId returns ''.
  assert.equal(renderProjectMemoryFactsBlock(null), '');
});

test('renderProjectMemoryFactsBlock formats as <system> bullet list', () => {
  upsertProjectFact(bobProjectId, 'stack', 'Next.js 15');
  upsertProjectFact(bobProjectId, 'db', 'postgres');
  const block = renderProjectMemoryFactsBlock(bobProjectId);
  assert.match(block, /^<system>\n/);
  assert.match(block, /Project facts \(persistent across all sessions in this project\):/);
  assert.match(block, /- stack: Next\.js 15/);
  assert.match(block, /- db: postgres/);
  assert.match(block, /<\/system>$/);
  // Sorted alphabetically by key.
  const stackIdx = block.indexOf('- stack:');
  const dbIdx = block.indexOf('- db:');
  assert.ok(dbIdx < stackIdx, 'sorted by key asc');
});

test('renderProjectMemoryFactsBlock collapses newlines and caps length', () => {
  upsertProjectFact(bobProjectId, 'multiline', 'line1\nline2\nline3');
  upsertProjectFact(bobProjectId, 'longvalue', 'x'.repeat(500));
  const block = renderProjectMemoryFactsBlock(bobProjectId);
  assert.match(block, /- multiline: line1 line2 line3/, 'newlines collapsed');
  // Per-value rendered cap is 240 chars (same as user facts).
  const m = block.match(/- longvalue: (x+)/);
  assert.ok(m);
  assert.equal(m[1].length, 240);
});

test('integration: prompt composition slots projectMemoryBlock between user facts and recall', () => {
  // Simulate the composition logic in llm-runner.js: project block
  // sits BELOW user facts and ABOVE recalled context.
  upsertProjectFact(bobProjectId, 'stack', 'Next.js 15');
  const systemPrompt = 'BASE PROMPT';
  const userMemoryBlock = '<system>\nUser facts:\n- foo: bar\n</system>';
  const projectMemoryBlock = renderProjectMemoryFactsBlock(bobProjectId);
  const recalledBlock = '<system>\nRecall:\n- some past snippet\n</system>';
  const composed = [userMemoryBlock, projectMemoryBlock, recalledBlock]
    .filter(Boolean)
    .reduce((acc, block) => acc + '\n\n' + block, systemPrompt);

  // Order: persona → user facts → project facts → recall.
  assert.match(composed, /^BASE PROMPT\n\n<system>\nUser facts/);
  assert.match(composed, /- stack: Next\.js 15/);
  assert.ok(
    composed.indexOf('- foo: bar') < composed.indexOf('- stack: Next.js 15'),
    'user facts come before project facts'
  );
  assert.ok(
    composed.indexOf('- stack: Next.js 15') < composed.indexOf('some past snippet'),
    'project facts come before recall'
  );

  // Empty project facts: composed == unchanged (filter drops empty).
  const empty = renderProjectMemoryFactsBlock(bobProjectId);
  for (const f of listProjectFacts(bobProjectId)) deleteProjectFact(bobProjectId, f.id);
  const emptyAfter = renderProjectMemoryFactsBlock(bobProjectId);
  const composedEmpty = [userMemoryBlock, emptyAfter, recalledBlock]
    .filter(Boolean)
    .reduce((acc, block) => acc + '\n\n' + block, systemPrompt);
  // The original test used empty placeholder 'empty' which is non-empty
  // string — verify the filter actually drops an empty string.
  assert.equal(emptyAfter, '', 'no facts → empty string');
  // Ensure the user-memory and recall blocks still compose cleanly
  // when project block is absent.
  assert.match(composedEmpty, /- foo: bar/);
  assert.match(composedEmpty, /some past snippet/);
});