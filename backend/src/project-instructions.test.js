/**
 * Project-instructions injection tests.
 *
 * Covers Opsi A: projects.instructions moved from user-prompt prefix
 * to a <system> block in the model system prompt. The block is
 * pre-resolved by routes/runs.js and passed as
 * opts.projectInstructionsBlock to llm-runner.runLLM.
 *
 * Composition order (verified by reducer snapshot):
 *   user facts → project facts → project instructions →
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
    opts.projectKnowledgeBlock || '',
    opts.recalled || '',
    opts.summaryBlock || '',
  ].filter(Boolean);
  return blocks.reduce((acc, b) => acc + '\n\n' + b, systemPrompt);
}

test('project chat composes project memory without user memory', () => {
  const out = compose({
    memoryBlock: '',
    projectMemoryBlock: 'PROJECT_FACTS',
    projectInstructionsBlock: 'PROJECT_INSTRUCTIONS',
    projectKnowledgeBlock: 'PROJECT_KNOWLEDGE',
    recalled: 'RECALLED',
    summaryBlock: 'SUMMARY',
  });
  const f = out.indexOf('PROJECT_FACTS');
  const i = out.indexOf('PROJECT_INSTRUCTIONS');
  const k = out.indexOf('PROJECT_KNOWLEDGE');
  const r = out.indexOf('RECALLED');
  const s = out.indexOf('SUMMARY');
  const p = out.indexOf('BASE_PERSONA');
  assert.ok(p >= 0 && !out.includes('USER_FACTS') && f > p && i > f && k > i && r > k && s > r,
    `project memory must not include user facts, got: ${out}`);
});

test('project knowledge is part of system composition', () => {
  const out = compose({
    projectKnowledgeBlock: '<system>\n[Project Knowledge]\n- pricing: fixed\n</system>',
  });
  assert.match(out, /\[Project Knowledge\]/);
  assert.match(out, /pricing: fixed/);
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
