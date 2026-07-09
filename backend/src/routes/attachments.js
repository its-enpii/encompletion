import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../db/index.js';

const router = express.Router();

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(process.cwd(), 'storage/attachments');

fs.mkdirSync(STORAGE_PATH, { recursive: true });

const MAX_BYTES = (parseInt(process.env.MAX_ATTACHMENT_SIZE_MB || '10', 10)) * 1024 * 1024;

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/x-sh'];
function isProbablyText(mime = '', name = '') {
  if (mime.startsWith('text/')) return true;
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  // common code extensions
  return /\.(txt|md|markdown|json|ya?ml|xml|html?|css|scss|sass|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|ps1|env|ini|toml|cfg|conf|log|csv|tsv|vue|svelte|astro|mdx|tex|groovy|dart|lua|rs|toml|gradle|dockerfile|gitignore|gitattributes|editorconfig|htaccess|yaml|lock)$/i.test(name);
}

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

    const content = isProbablyText(mimeType || '', name)
      ? buf.toString('utf8').slice(0, 200_000) // cap 200KB inline content
      : null;

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

// Serve a stored file by its stored file_name
router.get('/file/:fileName', (req, res) => {
  const safe = req.params.fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const full = path.join(STORAGE_PATH, safe);
  if (!full.startsWith(STORAGE_PATH) || !fs.existsSync(full)) {
    return res.status(404).end();
  }
  res.sendFile(full);
});

export default router;