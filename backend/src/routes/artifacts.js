import express from 'express';
import db from '../db/index.js';

const router = express.Router();

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

export default router;
