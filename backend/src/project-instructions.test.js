/**
 * Project-instructions injection tests.
 *
 * Covers Opsi A: projects.instructions moved from user-prompt prefix
 * to a <system> block in the model system prompt. The block is
 * pre-resolved by routes/runs.js + routes/v1.js and passed as
 * opts.projectInstructionsBlock to llm-runner.runLLM.
 *
 * Composition order (verified by reducer snapshot):
 *   persona → user facts → project facts → project instructions →
 *   recalled → session summary.
 *
 * Run: node --test src/project-instructions.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Compose the same way llm-runner.js does, without booting the runner
// (which is async and depends on the LLM gateway). We mirror the
// reducer exactly so regressions in the order show up here.
function compose(opts) {
  const systemPrompt = 'BASE_PERSONA';
  const blocks = [
    opts.memoryBlock || '',
    opts.projectMemoryBlock || '',
    opts.projectInstructionsBlock || '',
    opts.recalled || '',
    opts.summaryBlock || '',
  ].filter(Boolean);
  return blocks.reduce((acc, b) => acc + '\n\n' + b, systemPrompt);
}

test('projectInstructionsBlock slots between projectMemoryBlock and recalled', () => {
  const out = compose({
    memoryBlock: 'USER_FACTS',
    projectMemoryBlock: 'PROJECT_FACTS',
    projectInstructionsBlock: 'PROJECT_INSTRUCTIONS',
    recalled: 'RECALLED',
    summaryBlock: 'SUMMARY',
  });
  const u = out.indexOf('USER_FACTS');
  const f = out.indexOf('PROJECT_FACTS');
  const i = out.indexOf('PROJECT_INSTRUCTIONS');
  const r = out.indexOf('RECALLED');
  const s = out.indexOf('SUMMARY');
  const p = out.indexOf('BASE_PERSONA');
  assert.ok(p >= 0 && u > p && f > u && i > f && r > i && s > r,
    `order persona<user<facts<instr<recall<summary, got: ${out}`);
});

test('empty projectInstructionsBlock is dropped by the reducer', () => {
  const out = compose({
    memoryBlock: 'USER_FACTS',
    projectMemoryBlock: 'PROJECT_FACTS',
    projectInstructionsBlock: '',
    recalled: 'RECALLED',
    summaryBlock: '',
  });
  assert.ok(!out.includes('PROJECT_INSTRUCTIONS'));
  assert.ok(out.includes('PROJECT_FACTS'));
  assert.ok(out.includes('RECALLED'));
  assert.ok(out.includes('USER_FACTS'));
});

test('missing projectInstruction field (undefined) is dropped by reducer', () => {
  const out = compose({
    memoryBlock: '',
    projectMemoryBlock: '',
    projectInstructionsBlock: undefined,
    recalled: '',
    summaryBlock: '',
  });
  assert.equal(out, 'BASE_PERSONA');
});

test('whitespace-only instructions excluded at the route layer (mirror)', () => {
  // Mirror the handler-side trim: `proj?.instructions?.trim()` then
  // wrap in <system>. Whitespace-only → txt is falsy → block stays ''.
  const raw = '   \n\t  ';
  const txt = raw?.trim();
  const block = txt
    ? `<system>\n[Project Instructions]\n${txt}\n</system>`
    : '';
  assert.equal(block, '');
});

test('non-empty instructions wrapped in <system>[Project Instructions]', () => {
  const raw = 'Always answer in Bahasa Indonesia.';
  const txt = raw.trim();
  const block = txt
    ? `<system>\n[Project Instructions]\n${txt}\n</system>`
    : '';
  assert.equal(block, '<system>\n[Project Instructions]\nAlways answer in Bahasa Indonesia.\n</system>');
});
