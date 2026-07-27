import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { extractText } from '../extractors.js';

const router = express.Router();

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(process.cwd(), 'storage/attachments');

fs.mkdirSync(STORAGE_PATH, { recursive: true });
const STORAGE_PATH_REAL = fs.realpathSync(STORAGE_PATH);
const STORAGE_PATH_WITH_SEP = STORAGE_PATH_REAL + path.sep;

// Strict client-supplied filename: must start with the server-generated
// 16-hex ID + dash, then any [A-Za-z0-9._-]. No path separators, no traversal.
const CLIENT_FILENAME_RE = /^[a-f0-9]{16}-[A-Za-z0-9._-]+$/;

const MAX_BYTES = (parseInt(process.env.MAX_ATTACHMENT_SIZE_MB || '25', 10)) * 1024 * 1024;

// Ownership ledger — files uploaded before this table existed have no row
// and stay readable by any authenticated user (legacy). New uploads bind
// to req.user.id and GET enforces the match (admin can read any).
db.exec(`
  CREATE TABLE IF NOT EXISTS uploaded_files (
    file_name   TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Upload one or more files (base64 encoded JSON)
router.post('/', async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] required' });
  }

  const saved = [];
  const insertOwner = db.prepare(
    `INSERT OR REPLACE INTO uploaded_files (file_name, user_id) VALUES (?, ?)`
  );
  for (const f of files) {
    const { name, mimeType, dataBase64 } = f;
    if (!name || !dataBase64) {
      return res.status(400).json({ error: 'each file needs name & dataBase64' });
    }
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > MAX_BYTES) {
      return res.status(413).json({ error: `${name} exceeds ${MAX_BYTES} bytes` });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const fileName = `${id}-${safeName}`;
    const fullPath = path.join(STORAGE_PATH, fileName);
    fs.writeFileSync(fullPath, buf);
    insertOwner.run(fileName, req.user.id);

    const content = await extractText({ buffer: buf, mimeType: mimeType || '', fileName: name });

    saved.push({
      file_name: name,
      file_path: fileName,
      mime_type: mimeType || 'application/octet-stream',
      size: buf.length,
      content,
      // URL without JWT — browser uses Authorization via authFetch, or
      // short-lived ?token only when embedding in <img src>. Prefer
      // authFetch blob URLs on the client.
      url: `/api/attachments/file/${fileName}`,
    });
  }
  res.json({ files: saved });
});

// Serve a stored file by its stored file_name. Ownership: if a ledger row
// exists, only owner or admin; missing row = legacy (any auth user).
router.get('/file/:fileName', (req, res) => {
  const fileName = String(req.params.fileName || '');
  if (!CLIENT_FILENAME_RE.test(fileName)) {
    return res.status(404).end();
  }
  const owner = db
    .prepare('SELECT user_id FROM uploaded_files WHERE file_name = ?')
    .get(fileName);
  if (owner && owner.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(404).end();
  }
  const full = path.join(STORAGE_PATH_REAL, fileName);
  const rel = path.relative(STORAGE_PATH_REAL, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(404).end();
  }
  let real;
  try { real = fs.realpathSync(full); }
  catch { return res.status(404).end(); }
  if (!real.startsWith(STORAGE_PATH_WITH_SEP)) {
    return res.status(404).end();
  }
  if (!fs.existsSync(real)) return res.status(404).end();
  res.sendFile(real);
});

export default router;
