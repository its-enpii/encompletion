import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import yauzl from 'yauzl';
import { ZipWriter } from './zip-writer.js';

function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zipFile.readEntry();
      zipFile.on('entry', (entry) => {
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
        });
      });
      zipFile.on('end', () => resolve(entries));
      zipFile.on('error', reject);
    });
  });
}

test('ZipWriter streams text and disk files without changing bytes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-writer-'));
  const diskPath = path.join(tempDir, 'report.pdf');
  const binary = crypto.randomBytes(4096);
  fs.writeFileSync(diskPath, binary);

  try {
    const chunks = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const zip = new ZipWriter(output);

    await zip.addFile('session/src/app.js', Buffer.from('console.log("ok");'));
    await zip.addFileFromPath('session/docs/report.pdf', diskPath);
    await new Promise((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
      zip.end();
    });

    const entries = await readZip(Buffer.concat(chunks));
    assert.equal(entries.get('session/src/app.js')?.toString('utf8'), 'console.log("ok");');
    assert.deepEqual(entries.get('session/docs/report.pdf'), binary);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
