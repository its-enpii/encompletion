import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username & password required' });
  }
  const user = db
    .prepare('SELECT id, username, password, role, display_name, disabled FROM users WHERE username = ?')
    .get(username);
  if (!user || !user.password) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (user.disabled) {
    return res.status(403).json({ error: 'account disabled' });
  }
  const ok = bcrypt.compareSync(password, user.password);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  const token = signToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name || null,
    },
  });
});

// Who am I (sanity check)
router.get('/me', requireAuth, (req, res) => {
  const settings = db
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .get(req.user.id);
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      display_name: req.user.display_name || null,
    },
    settings: settings || null,
  });
});

// Update user settings
router.patch('/settings', requireAuth, (req, res) => {
  const { default_model, theme, language } = req.body || {};
  const existing = db
    .prepare('SELECT id FROM user_settings WHERE user_id = ?')
    .get(req.user.id);
  if (existing) {
    db.prepare(
      `UPDATE user_settings
         SET default_model = COALESCE(?, default_model),
             theme         = COALESCE(?, theme),
             language      = COALESCE(?, language),
             updated_at    = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).run(default_model || null, theme || null, language || null, req.user.id);
  } else {
    db.prepare(
      `INSERT INTO user_settings (user_id, default_model, theme, language)
       VALUES (?, ?, ?, ?)`
    ).run(
      req.user.id,
      default_model || 'workspace',
      theme || 'dark',
      language || 'id'
    );
  }
  res.json(
    db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id)
  );
});

export default router;