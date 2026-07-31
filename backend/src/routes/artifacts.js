import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import db from '../db/index.js';

const router = express.Router();

const STORAGE_PATH = process.env.STORAGE_PATH
  ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
  : path.resolve(process.cwd(), 'storage/attachments');
fs.mkdirSync(STORAGE_PATH, { recursive: true });
const STORAGE_PATH_REAL = fs.realpathSync(STORAGE_PATH);
const STORAGE_PATH_WITH_SEP = STORAGE_PATH_REAL + path.sep;

// Single artifact fetch by id. Used by the in-chat ArtifactCard so we
// can keep the transcript payload small (only carry a preview string).
// Authorization mirrors /api/sessions/:id: members can see their own
// session's artifacts; admins see any.
function accessibleArtifact(id, user) {
  return db
    .prepare(
      `SELECT a.*
         FROM artifacts a
         JOIN sessions s ON s.id = a.session_id
        WHERE a.id = ?
          AND (s.user_id = ? OR ? = 'admin')`
    )
    .get(id, user.id, user.role || 'member');
}

router.get('/:id', (req, res) => {
  const row = accessibleArtifact(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// Binary download / inline preview for type=file artifacts.
// ?inline=1 → Content-Disposition: inline (PDF iframe preview).
router.get('/:id/download', (req, res) => {
  const row = accessibleArtifact(req.params.id, req.user);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.type !== 'file' || !row.file_path) {
    return res.status(400).json({ error: 'not a downloadable file artifact' });
  }
  const full = path.resolve(STORAGE_PATH_REAL, row.file_path);
  const rel = path.relative(STORAGE_PATH_REAL, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(404).json({ error: 'not found' });
  }
  let real;
  try { real = fs.realpathSync(full); }
  catch { return res.status(404).json({ error: 'not found' }); }
  if (!real.startsWith(STORAGE_PATH_WITH_SEP) && real !== STORAGE_PATH_REAL) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!fs.existsSync(real)) return res.status(404).json({ error: 'file missing' });

  const downloadName = row.title || path.basename(real);
  const inline = req.query.inline === '1' || req.query.inline === 'true';
  const mime = row.mime_type || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${String(downloadName).replace(/"/g, '')}"`
  );
  // Allow embedding PDF preview in same-origin iframe.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (row.file_size) res.setHeader('Content-Length', String(row.file_size));
  fs.createReadStream(real).pipe(res);
});

export default router;
