/**
 * seed-e2e.js — idempotent fixture loader for the Playwright e2e suite.
 *
 * Run from inside the backend container:
 *   node src/seed-e2e.js
 *
 * Creates (or no-ops if already present):
 *   - users:   admin (idempotent w/ server.js bootstrap), member (tester)
 *   - models:  workspace / sonnet-4-6 / haiku-4-5
 *   - project: "e2e-project" (admin-owned)
 *
 * Outputs a JSON blob on stdout so the test runner can read the IDs.
 */

import bcrypt from 'bcryptjs';
import db from './db/index.js';

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

function ensureProject({ user_id, name, description = null }) {
  const existing = db
    .prepare('SELECT id FROM projects WHERE user_id = ? AND name = ?')
    .get(user_id, name);
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO projects (user_id, name, description)
       VALUES (?, ?, ?)`
    )
    .run(user_id, name, description);
  return info.lastInsertRowid;
}

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

const workspaceModelId = ensureModel({ key: 'workspace', label: 'Workspace', sort_order: 0 });
const sonnetModelId = ensureModel({ key: 'claude-sonnet-4-6', label: 'Sonnet 4.6', sort_order: 10 });
const haikuModelId = ensureModel({ key: 'claude-haiku-4-5', label: 'Haiku 4.5', sort_order: 20 });

const projectId = ensureProject({
  user_id: adminId,
  name: 'e2e-project',
  description: 'Project used by Playwright e2e tests',
});

out({
  users: {
    admin: { id: adminId, username: 'admin', password: 'admin12345' },
    member: { id: memberId, username: 'e2e-member', password: 'e2e-member-12345' },
  },
  models: {
    workspace: workspaceModelId,
    sonnet: sonnetModelId,
    haiku: haikuModelId,
  },
  project: { id: projectId, name: 'e2e-project' },
});
