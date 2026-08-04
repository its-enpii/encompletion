import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDocumentBuild } from './document-build-runner.js';

function workspace() {
  const root = path.resolve(process.cwd(), 'storage/workdirs');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'document-build-'));
}

test('BuildDocument executes a generator and returns validated outputs', async () => {
  const cwd = workspace();
  try {
    fs.writeFileSync(path.join(cwd, 'build.mjs'), `
      import { Document, Packer, Paragraph } from 'docx';
      import { writeFile } from 'node:fs/promises';
      const document = new Document({ sections: [{ children: [new Paragraph('Hello document')] }] });
      await writeFile('output.docx', await Packer.toBuffer(document));
      console.log('built docx');
    `);
    const result = await runDocumentBuild({
      cwd,
      entrypoint: 'build.mjs',
      outputs: ['output.docx'],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].path, 'output.docx');
    assert.ok(result.outputs[0].size > 500);
    assert.match(result.stdout, /built docx/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BuildDocument blocks writes outside the session workspace', async () => {
  const cwd = workspace();
  const outside = path.resolve(cwd, '..', `document-build-outside-${Date.now()}.txt`);
  try {
    fs.writeFileSync(path.join(cwd, 'build.mjs'), `
      import { writeFile } from 'node:fs/promises';
      await writeFile(${JSON.stringify(outside)}, 'blocked');
    `);
    const result = await runDocumentBuild({
      cwd,
      entrypoint: 'build.mjs',
      outputs: ['output.pdf'],
    });
    assert.match(result.error, /document build failed/);
    assert.equal(fs.existsSync(outside), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('BuildDocument blocks network access', async () => {
  const cwd = workspace();
  try {
    fs.writeFileSync(path.join(cwd, 'build.mjs'), `
      await fetch('https://example.com');
    `);
    const result = await runDocumentBuild({
      cwd,
      entrypoint: 'build.mjs',
      outputs: ['output.pdf'],
    });
    assert.match(result.error, /document build failed/);
    assert.match(result.stderr, /network access is disabled/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('BuildDocument rejects unsupported output types before execution', async () => {
  const cwd = workspace();
  try {
    fs.writeFileSync(path.join(cwd, 'build.mjs'), 'throw new Error("must not run");');
    const result = await runDocumentBuild({
      cwd,
      entrypoint: 'build.mjs',
      outputs: ['payload.exe'],
    });
    assert.equal(result.error, 'unsupported document output: payload.exe');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
