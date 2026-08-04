import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import yauzl from 'yauzl';

const db = (await import('./db/index.js')).default;
const sessionsRouter = (await import('./routes/sessions.js')).default;

const storageRoot = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(process.cwd(), 'storage/attachments');
const seeded = { userIds: [], sessionIds: [], filePaths: [] };
let server;
let port;

before(async () => {
  const app = express();
  for (const layer of sessionsRouter.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods);
    const routePath = layer.route.path;
    const handlers = layer.route.stack.map((stack) => stack.handle);
    for (const method of methods) {
      app[method](
        `/api/sessions${routePath === '/' ? '' : routePath}`,
        (req, _res, next) => {
          req.user = {
            id: Number(req.header('X-Test-User')),
            role: req.header('X-Test-Role') || 'member',
          };
          next();
        },
        ...handlers,
      );
    }
  }
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const sessionId of seeded.sessionIds.splice(0)) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  for (const userId of seeded.userIds.splice(0)) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
  for (const filePath of seeded.filePaths.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

function seedArtifacts() {
  const suffix = crypto.randomBytes(5).toString('hex');
  const userId = Number(db.prepare(
    `INSERT INTO users (username, password, role) VALUES (?, NULL, 'member')`,
  ).run(`zip-${suffix}`).lastInsertRowid);
  seeded.userIds.push(userId);

  const sessionId = Number(db.prepare(
    `INSERT INTO sessions (user_id, title, model) VALUES (?, ?, 'workspace')`,
  ).run(userId, `multi artifact ${suffix}`).lastInsertRowid);
  seeded.sessionIds.push(sessionId);

  const messageId = Number(db.prepare(
    `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', 'done')`,
  ).run(sessionId).lastInsertRowid);

  const binary = crypto.randomBytes(4096);
  const relativeFile = `zip-tests/${suffix}/report.pdf`;
  const absoluteFile = path.join(storageRoot, ...relativeFile.split('/'));
  fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
  fs.writeFileSync(absoluteFile, binary);
  seeded.filePaths.push(absoluteFile);

  const insert = db.prepare(
    `INSERT INTO artifacts
       (session_id, message_id, type, language, title, content, file_path, mime_type, file_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(sessionId, messageId, 'code', 'javascript', 'src/app.js', 'console.log("one");', null, null, null);
  insert.run(sessionId, messageId, 'code', 'javascript', 'src/app.js', 'console.log("two");', null, null, null);
  insert.run(sessionId, messageId, 'file', 'pdf', 'docs/report.pdf', 'PDF document', relativeFile, 'application/pdf', binary.length);

  const ids = db.prepare(
    'SELECT id FROM artifacts WHERE session_id = ? AND message_id = ? ORDER BY id ASC',
  ).all(sessionId, messageId).map((row) => row.id);
  return { userId, sessionId, binary, ids };
}

function addArtifactInAnotherResponse(sessionId) {
  const messageId = Number(db.prepare(
    `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', 'another')`,
  ).run(sessionId).lastInsertRowid);
  return Number(db.prepare(
    `INSERT INTO artifacts
       (session_id, message_id, type, language, title, content)
     VALUES (?, ?, 'code', 'javascript', 'other.js', 'console.log("other");')`,
  ).run(sessionId, messageId).lastInsertRowid);
}

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

test('artifacts.zip preserves multiple text files and binary file bytes', async () => {
  const { userId, sessionId, binary, ids } = seedArtifacts();
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/artifacts.zip?ids=${ids.join(',')}`, {
    headers: { 'X-Test-User': String(userId) },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const entries = await readZip(Buffer.from(await response.arrayBuffer()));

  assert.equal(entries.size, 3);
  assert.equal(entries.get('src/app.js')?.toString('utf8'), 'console.log("one");');
  assert.equal(entries.get('src/app-2.js')?.toString('utf8'), 'console.log("two");');
  assert.deepEqual(entries.get('docs/report.pdf'), binary);
});

test('artifacts.zip requires an explicit response artifact selection', async () => {
  const { userId, sessionId } = seedArtifacts();
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/artifacts.zip`, {
    headers: { 'X-Test-User': String(userId) },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'artifact ids are required' });
});

test('artifacts.zip rejects files selected across assistant responses', async () => {
  const { userId, sessionId, ids } = seedArtifacts();
  const otherId = addArtifactInAnotherResponse(sessionId);
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${sessionId}/artifacts.zip?ids=${ids[0]},${otherId}`,
    { headers: { 'X-Test-User': String(userId) } },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'artifacts must belong to one assistant response' });
});
