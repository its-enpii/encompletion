/**
 * embed-workdir — per-tenant, per-external-user working directory.
 *
 * Layout: WORKDIR_ROOT/tenants/<tenant_id>/<sanitized_external_user_id>/
 *
 * The sanitize step is critical: external_user_id comes from the saas
 * app's user identifier, which the saas app controls but we don't.
 * Strip path separators + null bytes + traversal tokens so a hostile
 * or buggy upstream can't escape the per-user directory.
 *
 * Functions:
 *   resolveEmbedWorkdir(tenantId, externalUserId) -> absolute path
 *   ensureEmbedWorkdir(tenantId, externalUserId) -> same + mkdir
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKDIR_ROOT = process.env.WORKDIR_ROOT
  ? path.resolve(process.cwd(), process.env.WORKDIR_ROOT)
  : path.resolve(process.cwd(), 'storage/workdirs');
fs.mkdirSync(WORKDIR_ROOT, { recursive: true });

const TENANTS_ROOT = path.join(WORKDIR_ROOT, 'tenants');
fs.mkdirSync(TENANTS_ROOT, { recursive: true });

function sanitizeExternalUserId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 80);
  if (trimmed.length === 0) return null;
  // Allow alnum, dash, underscore, dot. Replace anything else with
  // underscore so a malicious id like "../../etc" can't traverse out.
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Belt-and-suspenders: still no traversal tokens after substitution.
  if (safe === '.' || safe === '..' || safe.startsWith('..')) return '_invalid';
  return safe;
}

function sanitizeTenantId(raw) {
  if (typeof raw !== 'string') return null;
  if (!/^tenant-[A-Za-z0-9._-]+$/.test(raw)) return null;
  return raw;
}

export function resolveEmbedWorkdir(tenantId, externalUserId) {
  const tid = sanitizeTenantId(tenantId);
  if (!tid) return null;
  const euid = sanitizeExternalUserId(externalUserId);
  if (!euid) return null;
  const p = path.join(TENANTS_ROOT, tid, euid);
  // Final defense — confirm the resolved path is still under the root.
  const root = fs.realpathSync(TENANTS_ROOT) + path.sep;
  if (!(p + path.sep).startsWith(root) && p !== TENANTS_ROOT) return null;
  return p;
}

export function ensureEmbedWorkdir(tenantId, externalUserId) {
  const p = resolveEmbedWorkdir(tenantId, externalUserId);
  if (!p) return null;
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignore */ }
  return p;
}

export function _rootForTests() {
  return TENANTS_ROOT;
}