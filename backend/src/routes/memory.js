import express from 'express';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { listFacts, upsertFact, deleteFact } from '../memory.js';

const router = express.Router();

router.use(requireAuth);

const MAX_KEY_LEN = 40;

router.get('/facts', (req, res) => {
  res.json({ facts: listFacts(req.user.id) });
});

router.put('/facts/:key', (req, res) => {
  // Key in the URL is the user-visible fact name (e.g. "lokasi"). The
  // upsert helper validates the regex so a single bad char → 400 here.
  const key = String(req.params.key || '').slice(0, MAX_KEY_LEN);
  const { value } = req.body || {};
  try {
    const row = upsertFact(req.user.id, key, value);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/facts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ok = deleteFact(req.user.id, id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Per-user auto-memory toggle. Default ON (1) when no settings row yet.
// Reader queries user_settings directly so we don't need to also seed a
// row just to read the toggle.
router.get('/settings', (req, res) => {
  const row = db
    .prepare(`SELECT auto_memory_enabled FROM user_settings WHERE user_id = ?`)
    .get(req.user.id);
  res.json({
    auto_memory_enabled: row ? row.auto_memory_enabled !== 0 : true,
  });
});

// Upsert path: creates a user_settings row if absent so the toggle
// reads back consistently next time. user_settings has no UNIQUE on
// user_id by design (we may add per-feature rows later), so we check
// existence + INSERT or UPDATE in two steps. Returns the new value.
router.put('/settings', (req, res) => {
  const enabled = req.body?.auto_memory_enabled ? 1 : 0;
  const existing = db
    .prepare(`SELECT id FROM user_settings WHERE user_id = ?`)
    .get(req.user.id);
  if (existing) {
    db.prepare(
      `UPDATE user_settings
          SET auto_memory_enabled = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?`
    ).run(enabled, req.user.id);
  } else {
    db.prepare(
      `INSERT INTO user_settings (user_id, auto_memory_enabled) VALUES (?, ?)`
    ).run(req.user.id, enabled);
  }
  res.json({ auto_memory_enabled: enabled === 1 });
});

export default router;