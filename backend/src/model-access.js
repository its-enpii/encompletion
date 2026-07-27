/**
 * Role → model RBAC helpers.
 * Empty role_models rows for a role = unrestricted (all enabled models).
 */
import db from './db/index.js';

export function allowedModelKeysForRole(role) {
  const r = role === 'admin' ? 'admin' : 'member';
  const grants = db
    .prepare('SELECT model_key FROM role_models WHERE role = ?')
    .all(r)
    .map((row) => row.model_key);
  if (grants.length === 0) {
    return db
      .prepare('SELECT key FROM models WHERE enabled = 1')
      .all()
      .map((row) => row.key);
  }
  const enabled = new Set(
    db.prepare('SELECT key FROM models WHERE enabled = 1').all().map((row) => row.key)
  );
  return grants.filter((k) => enabled.has(k));
}

export function roleMayUseModel(role, modelKey) {
  if (!modelKey || typeof modelKey !== 'string') return false;
  const key = modelKey.trim();
  if (!key) return false;
  return allowedModelKeysForRole(role).includes(key);
}
