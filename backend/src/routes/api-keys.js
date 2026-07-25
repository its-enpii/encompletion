/**
 * Internal API key CRUD — JWT-authed, only the owner can manage their
 * own keys. The plaintext key is returned EXACTLY ONCE on create; we
 * store only sha256(key) and never see the plaintext again.
 */

import express from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';

const router = express.Router();

const KEY_PREFIX = 'clw_';
const KEY_BYTES = 32; // 32 bytes → 64 hex chars

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function generatePlaintext() {
  const random = crypto.randomBytes(KEY_BYTES).toString('hex');
  return `${KEY_PREFIX}${random}`;
}

function maskKey(plaintext) {
  // clw_xxxxxxxx… — first 12 chars + ellipsis. Used for display only.
  if (typeof plaintext !== 'string' || plaintext.length < 12) return null;
  return `${plaintext.slice(0, 12)}…`;
}

function findKeyById(id, userId) {
  return db
    .prepare(
      `SELECT id, user_id, name, model, last_used_at, created_at
         FROM api_keys
         WHERE id = ? AND user_id = ?`
    )
    .get(id, userId);
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, model, last_used_at, created_at
         FROM api_keys
         WHERE user_id = ?
         ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({ keys: rows });
});

router.post('/', (req, res) => {
  const { name, model } = req.body || {};
  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    return res.status(400).json({ error: 'model is required' });
  }
  const trimmedName = name.trim().slice(0, 64);
  const trimmedModel = model.trim().slice(0, 64);

  // Validate model exists in registry (admins may have disabled
  // something we shouldn't accept as a key default).
  const m = db
    .prepare(`SELECT id FROM models WHERE key = ? AND enabled = 1`)
    .get(trimmedModel);
  if (!m) return res.status(400).json({ error: 'unknown or disabled model' });

  const plaintext = generatePlaintext();
  const hash = sha256(plaintext);
  const info = db
    .prepare(
      `INSERT INTO api_keys (user_id, name, model, key_hash)
       VALUES (?, ?, ?, ?)`
    )
    .run(req.user.id, trimmedName, trimmedModel, hash);

  // Plaintext is returned exactly here — never re-served by GET or any
  // other endpoint.
  res.status(201).json({
    id: info.lastInsertRowid,
    name: trimmedName,
    model: trimmedModel,
    plaintext,
    prefix: maskKey(plaintext),
    created_at: new Date().toISOString(),
  });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const row = findKeyById(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`).run(id, req.user.id);
  res.json({ ok: true });
});

export default router;
