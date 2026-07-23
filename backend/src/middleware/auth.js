import jwt from 'jsonwebtoken';
import db from '../db/index.js';

const DEV_FALLBACK_SECRET = 'dev-insecure-secret-change-me';
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.JWT_SECRET) {
  if (NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  console.warn('[auth] JWT_SECRET not set — using insecure development fallback');
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role || 'member' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function loadUser(id) {
  return db
    .prepare('SELECT id, username, role, display_name, disabled FROM users WHERE id = ?')
    .get(id);
}

/**
 * Express middleware: require Bearer token OR ?token= query.
 * Attaches req.user = { id, username, role, display_name }.
 */
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  let token = null;
  if (auth.startsWith('Bearer ')) token = auth.slice(7);
  if (!token && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'invalid token' });

  const user = loadUser(payload.sub);
  if (!user) return res.status(401).json({ error: 'user not found' });
  if (user.disabled) return res.status(403).json({ error: 'account disabled' });

  req.user = user;
  next();
}

/** Express middleware: require role === 'admin'. Must run after requireAuth. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin required' });
  }
  next();
}