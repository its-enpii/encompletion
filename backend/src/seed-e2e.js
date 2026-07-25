/**
 * seed-e2e.js — idempotent fixture loader for the Playwright e2e suite.
 *
 * Run from inside the backend container:
 *   node src/seed-e2e.js
 *
 * Creates (or no-ops if already present):
 *   - users:        admin (idempotent w/ server.js bootstrap),
 *                   member (tester), embed (tester)
 *   - models:       workspace / sonnet-4-6 / haiku-4-5 (server.js default)
 *   - tenant:       "e2e-tenant"
 *   - tenant key:   plain-text returned ONCE via stdout
 *   - embed token:  plain-text returned ONCE via stdout (for the embed widget tests)
 *   - project:      "e2e-project" (admin-owned, used by chat tests)
 *
 * Idempotent by name — re-runs are safe.
 *
 * Outputs a JSON blob on stdout so the test runner can read the IDs and
 * plaintext secrets without env-var plumbing.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import db from './db/index.js';
import { issueEmbedToken } from './embed-token.js';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function ensureUser({ username, password, role = 'member', display_name = null }) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return existing.id;
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (username, password, role, display_name)
       VALUES (?, ?, ?, ?)`
    )
    .run(username, hash, role, display_name || username);
  return info.lastInsertRowid;
}

function ensureModel({ key, label, sort_order }) {
  const existing = db.prepare('SELECT id FROM models WHERE key = ?').get(key);
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO models (key, label, enabled, sort_order) VALUES (?, ?, 1, ?)`
    )
    .run(key, label, sort_order);
  return info.lastInsertRowid;
}

function ensureTenant({ name, slug, status = 'active', default_model_id = null }) {
  const existing = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
  if (existing) return existing.id;
  const id = 'tenant-' + crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status, default_model_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, slug, status, default_model_id);
  return id;
}

function ensureTenantApiKey({ tenant_id, name }) {
  // Each run generates a NEW key (we want a clean slate; old keys are
  // not revoked because nothing else uses them, and the test caller
  // needs the plaintext to issue an embed token).
  const plaintext = 'tk_' + crypto.randomBytes(24).toString('base64url');
  const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const info = db
    .prepare(
      `INSERT INTO tenant_api_keys (tenant_id, name, key_hash)
       VALUES (?, ?, ?)`
    )
    .run(tenant_id, name, keyHash);
  return { id: info.lastInsertRowid, plaintext };
}

function ensureProject({ user_id, name, description = null }) {
  const existing = db
    .prepare('SELECT id FROM projects WHERE user_id = ? AND name = ? AND owner_type = ? AND owner_id = ?')
    .get(user_id, name, 'user', String(user_id));
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO projects (user_id, name, description, owner_type, owner_id)
       VALUES (?, ?, ?, 'user', ?)`
    )
    .run(user_id, name, description, String(user_id));
  return info.lastInsertRowid;
}

// ---- run ----

// 1. Users. Admin is the bootstrap user; member + embed are the test
//    fixtures. All passwords are deterministic for the test runner.
const adminId = ensureUser({
  username: 'admin',
  password: 'admin12345',
  role: 'admin',
  display_name: 'Administrator',
});
const memberId = ensureUser({
  username: 'e2e-member',
  password: 'e2e-member-12345',
  role: 'member',
  display_name: 'E2E Member',
});
const embedUserId = ensureUser({
  username: 'e2e-embed',
  password: 'e2e-embed-12345',
  role: 'member',
  display_name: 'E2E Embed User',
});

// 2. Models. Insert defaults (server.js does this on first boot too, but
//    we run before any other writes here so we own the IDs).
const workspaceModelId = ensureModel({ key: 'workspace', label: 'Workspace', sort_order: 0 });
const sonnetModelId = ensureModel({ key: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sort_order: 10 });
const haikuModelId = ensureModel({ key: 'claude-haiku-4-5', label: 'Haiku 4.5', sort_order: 20 });

// 3. Tenant. Binds to sonnet by default so embed tests get a known model.
const tenantId = ensureTenant({
  name: 'E2E Tenant',
  slug: 'e2e-tenant',
  status: 'active',
  default_model_id: sonnetModelId,
});

// 4. Tenant API key. Plaintext returned for the test runner to call
//    /api/embed/token with.
const tenantKey = ensureTenantApiKey({
  tenant_id: tenantId,
  name: 'e2e-suite',
});

// 5. Project. Admin-owned so the chat tests have a project_id to bind.
const projectId = ensureProject({
  user_id: adminId,
  name: 'e2e-project',
  description: 'Project used by Playwright e2e tests',
});

// 6. Issue an embed token up-front. The plaintext is what the embed
//    widget tests will pass as Bearer. The (tenant, external_user_id)
//    pair is the one the embed-admin tests will use.
const embedToken = issueEmbedToken(tenantId, 'e2e-external-user');

out({
  users: {
    admin: { id: adminId, username: 'admin', password: 'admin12345' },
    member: { id: memberId, username: 'e2e-member', password: 'e2e-member-12345' },
    embed: { id: embedUserId, username: 'e2e-embed', password: 'e2e-embed-12345' },
  },
  models: {
    workspace: workspaceModelId,
    sonnet: sonnetModelId,
    haiku: haikuModelId,
  },
  tenant: { id: tenantId, slug: 'e2e-tenant' },
  tenantApiKey: { id: tenantKey.id, plaintext: tenantKey.plaintext },
  project: { id: projectId, name: 'e2e-project' },
  embedToken: {
    token: embedToken.embed_token,
    expires_at: embedToken.expires_at,
    tenant_id: tenantId,
    external_user_id: 'e2e-external-user',
  },
});
