/**
 * Compactor tests — pure logic coverage with a mocked LLM.
 *
 * Coverage:
 *  1. Empty messages → ''
 *  2. Short transcript → returns summary text from LLM
 *  3. Returns output as-is (post-truncation only)
 *  4. Truncates output to MAX_SUMMARY_CHARS
 *  5. LLM error → ''
 *  6. Non-array messages → ''
 *
 * Run: node --test src/compactor.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  compactTranscript,
  _setCompactorLLMForTests,
  _resetCompactorLLMForTests,
  _internals,
} = await import('./compactor.js');

before(() => {
  // Default mock: returns valid summary so test setup doesn't
  // accidentally hit the real LLM.
  _setCompactorLLMForTests(async () => 'Topic: testing. The user wants to verify the compactor works.');
});

after(() => {
  _resetCompactorLLMForTests();
});

test('empty messages → ""', async () => {
  assert.equal(await compactTranscript([]), '');
  assert.equal(await compactTranscript(null), '');
  assert.equal(await compactTranscript(undefined), '');
});

test('short transcript → returns summary text from LLM', async () => {
  _setCompactorLLMForTests(async () => 'Topic: short test. Both sides agreed.');
  const out = await compactTranscript([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.ok(out.length > 0);
  assert.match(out, /Topic: short test/);
});

test('returns output as-is when within MAX_SUMMARY_CHARS', async () => {
  const text = 'A short summary that fits comfortably.';
  _setCompactorLLMForTests(async () => text);
  const out = await compactTranscript([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: 'y' },
  ]);
  assert.equal(out, text);
});

test('truncates output to MAX_SUMMARY_CHARS', async () => {
  const longText = 'x'.repeat(_internals.MAX_SUMMARY_CHARS + 500);
  _setCompactorLLMForTests(async () => longText);
  const out = await compactTranscript([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ]);
  assert.equal(out.length, _internals.MAX_SUMMARY_CHARS);
});

test('LLM error → ""', async () => {
  _setCompactorLLMForTests(async () => { throw new Error('simulated failure'); });
  const out = await compactTranscript([
    { role: 'user', content: 'x' },
  ]);
  assert.equal(out, '');
});

test('non-array messages → ""', async () => {
  assert.equal(await compactTranscript('not an array'), '');
  assert.equal(await compactTranscript(42), '');
  assert.equal(await compactTranscript({}), '');
});