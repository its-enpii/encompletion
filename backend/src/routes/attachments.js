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

// Upload one or more files (base64 encoded JSON)
router.post('/', async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] required' });
  }

  const saved = [];
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

    // Try to extract plain text content from the binary. For PDFs and
    // Office docs this is what turns them into something the LLM can
    // quote; for code/text formats it duplicates the utf-8 read but is
    // cheaper than branching here.
    const content = await extractText({ buffer: buf, mimeType: mimeType || '', fileName: name });

    saved.push({
      file_name: name,
      file_path: fileName,
      mime_type: mimeType || 'application/octet-stream',
      size: buf.length,
      content,
      url: `/api/attachments/file/${fileName}`,
    });
  }
  res.json({ files: saved });
});

// Serve a stored file by its stored file_name. Accepts only filenames
// produced by POST / (16-hex id prefix + sanitized display name) and
// resolves through path.relative to reject anything escaping the dir,
// including symlinks pointing outside it.
router.get('/file/:fileName', (req, res) => {
  const fileName = String(req.params.fileName || '');
  if (!CLIENT_FILENAME_RE.test(fileName)) {
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