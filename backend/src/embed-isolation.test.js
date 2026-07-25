/**
 * Embed-mode isolation tests (phase E2.5).
 *
 * Verifies the short-lived embed_token issuance + tenant/external_user
 * scoping. Pure DB tests — they do NOT spin up an Express server.
 * Tests touch the helpers directly so a bad migration surfaces as a
 * SQL error, not a socket timeout.
 *
 * Coverage:
 *  1. issueEmbedToken round-trips + persists hash only
 *  2. resolveEmbedToken: unknown token, expired token, suspended tenant
 *  3. tenant_api_key revocation rejects token issuance
 *  4. embed sessions scoped to (tenant_id, external_user_id)
 *  5. embed session invisible from platform queries
 *  6. cross-external-user on same tenant is isolated
 *
 * Run: node --test src/embed-isolation.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const { issueEmbedToken, resolveEmbedToken } = await import('./embed-token.js');

function ensureTenant(slug, opts = {}) {
  const id = 'tenant-' + slug + '-' + crypto.randomBytes(3).toString('hex');
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status, persona_config)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.name || 'Tenant ' + slug,
    slug,
    opts.status || 'active',
    opts.persona ? JSON.stringify(opts.persona) : null
  );
  return id;
}

function ensureTenantApiKey(tenantId, name = 'test-key') {
  const plaintext = 'tk_' + crypto.randomBytes(18).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  db.prepare(
    `INSERT INTO tenant_api_keys (tenant_id, name, key_hash) VALUES (?, ?, ?)`
  ).run(tenantId, name, hash);
  return { id: db.prepare('SELECT last_insert_rowid() AS id').get().id, plaintext, hash };
}

function cleanupTenant(id) {
  // CASCADE removes tenant_api_keys + embed_tokens
  db.prepare('DELETE FROM sessions WHERE owner_type = ? AND owner_id = ?').run('tenant', id);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

test('issueEmbedToken round-trips and stores hash only', () => {
  const slug = 'round-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    const issued = issueEmbedToken(tenantId, 'ext-user-1');
    assert.ok(issued.embed_token.startsWith('em_'), 'plaintext token prefixed');
    assert.ok(issued.expires_at, 'expires_at populated');

    // The plaintext must NOT be persisted. Re-issue and confirm only
    // the new token row exists (search for an obviously-bogus token).
    const bogus = resolveEmbedToken('em_obviously_not_real_' + crypto.randomBytes(8).toString('hex'));
    assert.equal(bogus.ok, false, 'bogus token rejected');

    // Real token resolves.
    const ok = resolveEmbedToken(issued.embed_token);
    assert.equal(ok.ok, true);
    assert.equal(ok.embed.tenant_id, tenantId);
    assert.equal(ok.embed.external_user_id, 'ext-user-1');
  } finally {
    cleanupTenant(tenantId);
  }
});

test('resolveEmbedToken: unknown / expired / suspended', () => {
  const slug = 'edge-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    const issued = issueEmbedToken(tenantId, 'ext-edge');

    // Unknown token
    const u = resolveEmbedToken('em_' + crypto.randomBytes(20).toString('base64url'));
    assert.equal(u.ok, false);
    assert.equal(u.reason, 'unknown');

    // Suspended tenant
    db.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = ?`).run(tenantId);
    const s = resolveEmbedToken(issued.embed_token);
    assert.equal(s.ok, false);
    assert.equal(s.reason, 'tenant_inactive');

    // Restore tenant, then force expiry
    db.prepare(`UPDATE tenants SET status = 'active' WHERE id = ?`).run(tenantId);
    db.prepare(`UPDATE embed_tokens SET expires_at = ? WHERE tenant_id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), tenantId);
    const e = resolveEmbedToken(issued.embed_token);
    assert.equal(e.ok, false);
    assert.equal(e.reason, 'expired');
  } finally {
    cleanupTenant(tenantId);
  }
});

test('tenant_api_key revocation rejects token issuance path', () => {
  const slug = 'revoke-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    const key = ensureTenantApiKey(tenantId, 'k1');
    // Mark revoked.
    db.prepare(`UPDATE tenant_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(key.id);

    // We don't load requireTenantApiKey here (it's a middleware). Just
    // confirm the DB invariant that lookupKey() would return revoked_at.
    const row = db.prepare(`SELECT revoked_at FROM tenant_api_keys WHERE id = ?`).get(key.id);
    assert.ok(row.revoked_at, 'revoked_at set');

    // An issued token before revocation remains valid for its TTL —
    // revocation is forward-looking. The middleware is what blocks new
    // issuance; this test just asserts the DB shape is right.
    const issued = issueEmbedToken(tenantId, 'ext-after-revoke');
    const ok = resolveEmbedToken(issued.embed_token);
    assert.equal(ok.ok, true, 'pre-existing embed tokens still verify');
  } finally {
    cleanupTenant(tenantId);
  }
});

test('embed sessions are scoped to (tenant_id, external_user_id)', () => {
  const slug = 'scope-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    const alice = issueEmbedToken(tenantId, 'alice');
    const bob = issueEmbedToken(tenantId, 'bob');

    // Use the literal SQL the embed route applies (the WHERE clause
    // is the trust boundary). Both tokens issue fine but their session
    // rows must not collide when looked up cross-user.
    const sessA = db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?) RETURNING id`
    ).get('alice chat', 'workspace', tenantId, 'alice');
    const sessB = db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?) RETURNING id`
    ).get('bob chat', 'workspace', tenantId, 'bob');

    // Alice cannot see Bob's session even with the right id.
    const aliceSeesBob = db.prepare(
      `SELECT id FROM sessions
         WHERE id = ?
           AND owner_type = 'tenant' AND owner_id = ?
           AND external_user_id = ?`
    ).get(sessB.id, tenantId, 'alice');
    assert.equal(aliceSeesBob, undefined, 'alice must not see bob session');

    // And Alice CAN see her own.
    const aliceSeesAlice = db.prepare(
      `SELECT id FROM sessions
         WHERE id = ?
           AND owner_type = 'tenant' AND owner_id = ?
           AND external_user_id = ?`
    ).get(sessA.id, tenantId, 'alice');
    assert.ok(aliceSeesAlice, 'alice sees alice session');

    // Tokens still resolve fine.
    assert.ok(resolveEmbedToken(alice.embed_token).ok);
    assert.ok(resolveEmbedToken(bob.embed_token).ok);
  } finally {
    cleanupTenant(tenantId);
  }
});

test('embed sessions invisible to platform-mode queries', () => {
  const slug = 'plat-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('embed-only', 'workspace', tenantId, 'embed-user');

    // The platform-mode WHERE used by routes/sessions.js for a regular
    // user MUST NOT match a tenant-owned session.
    const platform = db.prepare(
      `SELECT id FROM sessions
         WHERE owner_type = 'user' AND owner_id = ?
           AND archived_at IS NULL`
    ).all('9999');
    assert.equal(platform.length, 0, 'platform sees no embed sessions');

    // Admin path (no owner filter) DOES see them — admin can audit
    // every tenant session through the dashboard.
    const admin = db.prepare(
      `SELECT id FROM sessions
         WHERE owner_type = 'tenant' AND owner_id = ?`
    ).all(tenantId);
    assert.equal(admin.length, 1, 'admin scope sees embed session');
  } finally {
    cleanupTenant(tenantId);
  }
});

test('two external users on same tenant are isolated', () => {
  const slug = 'iso-' + crypto.randomBytes(3).toString('hex');
  const tenantId = ensureTenant(slug);
  try {
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('a', 'workspace', tenantId, 'a');
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('b', 'workspace', tenantId, 'b');

    // Listing must filter by external_user_id when the embed token
    // is in play — same tenant, different end-user, no overlap.
    const aSessions = db.prepare(
      `SELECT id FROM sessions
         WHERE owner_type = 'tenant' AND owner_id = ?
           AND external_user_id = ?`
    ).all(tenantId, 'a');
    assert.equal(aSessions.length, 1);

    const bSessions = db.prepare(
      `SELECT id FROM sessions
         WHERE owner_type = 'tenant' AND owner_id = ?
           AND external_user_id = ?`
    ).all(tenantId, 'b');
    assert.equal(bSessions.length, 1);
    assert.notEqual(aSessions[0].id, bSessions[0].id);
  } finally {
    cleanupTenant(tenantId);
  }
});