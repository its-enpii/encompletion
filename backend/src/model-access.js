/**
 * Role → model RBAC helpers.
 * Empty role_models rows for a role = unrestricted (all enabled models).
 * Role slug is used as-is (custom roles are first-class for grants).
 */
import db from './db/index.js';

export function allowedModelKeysForRole(role) {
  const r = typeof role === 'string' && role.trim() ? role.trim() : 'member';
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

/** True if slug exists in roles table. */
export function roleExists(role) {
  if (!role || typeof role !== 'string') return false;
  return !!db.prepare('SELECT id FROM roles WHERE id = ?').get(role.trim());
}

/** All role ids ordered for UI selects. */
export function listRoleIds() {
  return db
    .prepare('SELECT id FROM roles ORDER BY sort_order ASC, id ASC')
    .all()
    .map((r) => r.id);
}
