/**
 * Extractor tests — pure logic coverage with a mocked LLM. No HTTP.
 *
 * Coverage:
 *  1. Empty messages → []
 *  2. Valid JSON facts → parsed and sanitized
 *  3. ```json fenced output → still parses
 *  4. Invalid JSON → [] (no throw)
 *  5. Bad keys (non-conforming chars, too long, leading digit) → filtered
 *  6. Too-long values → truncated to 200 chars
 *  7. > 8 facts → capped at 8
 *  8. Mixed valid/invalid rows → only valid kept
 *
 * LLM is mocked via _setExtractorLLMForTests.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const {
  extractFactsFromTranscript,
  _setExtractorLLMForTests,
  _resetExtractorLLMForTests,
  _internals,
} = await import('./extractor.js');

before(() => {
  // Default mock: a no-op that returns valid empty JSON so test setup
  // doesn't accidentally hit the real LLM.
  _setExtractorLLMForTests(async () => '{"facts":[]}');
});

after(() => {
  _resetExtractorLLMForTests();
});

test('empty messages → []', async () => {
  assert.deepEqual(await extractFactsFromTranscript([]), []);
  assert.deepEqual(await extractFactsFromTranscript(null), []);
});

test('valid JSON facts are parsed and sanitized', async () => {
  _setExtractorLLMForTests(async () => JSON.stringify({
    facts: [
      { key: "Lokasi", value: "Jakarta" },
      { key: "role", value: "senior engineer" },
    ],
  }));
  const out = await extractFactsFromTranscript([
    { role: "user", content: "Saya tinggal di Jakarta." },
    { role: "assistant", content: "OK" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { key: "lokasi", value: "Jakarta" });
  assert.deepEqual(out[1], { key: "role", value: "senior engineer" });
});

test('```json fenced output is still parsed', async () => {
  _setExtractorLLMForTests(async () =>
    "Here you go:\n```json\n" + JSON.stringify({ facts: [{ key: "lang", value: "id" }] }) + "\n```\nDone."
  );
  const out = await extractFactsFromTranscript([
    { role: "user", content: "Bhs Indo" },
    { role: "assistant", content: "OK" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "lang");
});

test('invalid JSON returns [] without throwing', async () => {
  _setExtractorLLMForTests(async () => "not json at all {{{{");
  const out = await extractFactsFromTranscript([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hi" },
  ]);
  assert.deepEqual(out, []);
});

test('bad keys are filtered out', async () => {
  _setExtractorLLMForTests(async () => JSON.stringify({
    facts: [
      { key: "valid_key", value: "ok" },
      { key: "1leading_digit", value: "x" },      // starts with digit → filtered
      { key: "has space", value: "x" },            // space → key becomes "hasspace" by sanitization; but starts with letter so still passes key sanitation... filter is 'starts with letter' from extractFactsFromTranscript
      { key: "x".repeat(50), value: "x" },          // too long → truncated, but if first letter OK keeps
    ],
  }));
  const out = await extractFactsFromTranscript([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hi" },
  ]);
  // 'valid_key' passes; '1leading_digit' filtered (digit start); 'x' * 50
  // gets truncated to 40 chars by sanitizer — still valid (still letter-start).
  const keys = out.map((f) => f.key);
  assert.ok(keys.includes("valid_key"));
  assert.ok(!keys.includes("1leading_digit"));
  // The x*40 case ends up as 'x' * 40 which does start with 'x'.
  assert.ok(keys.some((k) => k.length === 40 && /^x+$/.test(k)));
});

test('too-long values are truncated', async () => {
  _setExtractorLLMForTests(async () => JSON.stringify({
    facts: [{ key: "longvalue", value: "z".repeat(_internals.MAX_VALUE + 100) }],
  }));
  const out = await extractFactsFromTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value.length, _internals.MAX_VALUE);
});

test('> 8 facts is capped at MAX_FACTS', async () => {
  const big = Array.from({ length: 20 }, (_, i) => ({
    key: `k${String(i).padStart(2, "0")}`,
    value: `v${i}`,
  }));
  _setExtractorLLMForTests(async () => JSON.stringify({ facts: big }));
  const out = await extractFactsFromTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
  ]);
  assert.equal(out.length, _internals.MAX_FACTS);
  assert.equal(out.length, 8);
});

test('mixed valid/invalid rows: only valid survive', async () => {
  _setExtractorLLMForTests(async () => JSON.stringify({
    facts: [
      { key: "ok1", value: "v1" },
      { key: null, value: "v2" },           // bad key
      { key: "ok2", value: 42 },             // bad value type → filtered
      { key: "ok3", value: "v3" },
    ],
  }));
  const out = await extractFactsFromTranscript([
    { role: "user", content: "x" },
    { role: "assistant", content: "y" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.key).sort(), ["ok1", "ok3"]);
});

test('only user-side messages with no assistant turn → returns [] (caller-skip)', async () => {
  // extractFactsFromTranscript only filters empty + invalid; the worker
  // is responsible for the "needs both roles" check. So when only one
  // user message is passed, the extractor still produces whatever the
  // LLM returned. Verify it doesn't crash with a one-message array.
  _setExtractorLLMForTests(async () => '{"facts":[]}');
  const out = await extractFactsFromTranscript([
    { role: "user", content: "tell me about X" },
  ]);
  assert.deepEqual(out, []);
});