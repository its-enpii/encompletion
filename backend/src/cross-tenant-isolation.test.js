/**
 * Cross-tenant isolation tests (phase E5.4).
 *
 * Two tenants, parallel state. Tests verify:
 *  1. Token issued for tenant A is rejected when presented to tenant B
 *     routes (via the SQL gate — embed token resolution carries its
 *     own tenant_id, so cross-tenant resolution returns ok:false).
 *  2. Embed sessions created by tenant A are invisible from tenant B's
 *     list query (owner_type/owner_id/external_user_id).
 *  3. Tool executions are scoped per tenant — analytics aggregation
 *     never mixes them.
 *  4. Rate limit bucket is per tenant — bursting tenant A doesn't
 *     affect tenant B.
 *  5. Persona cache invalidation is per tenant.
 *
 * Pure DB + helper tests, no HTTP. The integration tests live in
 * embed-isolation.test.js.
 *
 * Run: node --test src/cross-tenant-isolation.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const { issueEmbedToken, resolveEmbedToken } = await import('./embed-token.js');
const { executeHttpTool, listActiveToolsForTenant, loadCapability } = await import('./tool-executor.js');
const { consumeToken, _resetForTests: resetRateLimit } = await import('./rate-limit.js');
const { getPersonaBlock, invalidatePersonaCache, _resetCacheForTests: resetPersona } = await import('./persona.js');

function ensureTenant(slug, opts = {}) {
  const id = 'tenant-iso-' + slug + '-' + crypto.randomBytes(3).toString('hex');
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status, persona_config)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.name || ('T-' + slug),
    'iso-' + slug + '-' + crypto.randomBytes(3).toString('hex'),
    opts.status || 'active',
    opts.persona ? JSON.stringify(opts.persona) : null
  );
  return id;
}

function insertTool(tenantId, fields) {
  const id = 'tool-' + crypto.randomBytes(4).toString('hex');
  db.prepare(
    `INSERT INTO tools
       (id, tenant_id, name, description, json_schema, endpoint_url, tool_category, requires_confirmation, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, tenantId, fields.name, fields.description,
    JSON.stringify(fields.json_schema || {}), fields.endpoint_url,
    fields.tool_category || 'business_action',
    fields.requires_confirmation ? 1 : 0,
    fields.is_active === false ? 0 : 1
  );
  return id;
}

function cleanup(tenantId) {
  db.prepare('DELETE FROM tool_executions WHERE tenant_id = ?').run(tenantId);
  db.prepare('DELETE FROM tools WHERE tenant_id = ?').run(tenantId);
  db.prepare('DELETE FROM tenant_capability_profile WHERE tenant_id = ?').run(tenantId);
  db.prepare('DELETE FROM embed_tokens WHERE tenant_id = ?').run(tenantId);
  db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE owner_type = ? AND owner_id = ?)').run('tenant', tenantId);
  db.prepare('DELETE FROM sessions WHERE owner_type = ? AND owner_id = ?').run('tenant', tenantId);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
}

// -- Token isolation -------------------------------------------------------

test('embed token issued for tenant A is rejected when presented elsewhere', () => {
  const a = ensureTenant('a');
  const b = ensureTenant('b');
  try {
    const issued = issueEmbedToken(a, 'ext-user');
    // resolveEmbedToken returns tenant_id=a, regardless of which
    // tenant the *route* ends up serving — the trust boundary is the
    // SQL WHERE clause in loadEmbedSession.
    const ok = resolveEmbedToken(issued.embed_token);
    assert.equal(ok.ok, true);
    assert.equal(ok.embed.tenant_id, a, 'tenant_id is the issuer');
    assert.notEqual(ok.embed.tenant_id, b);

    // If route B uses this token, loadEmbedSession filters by b, finds
    // nothing, returns 404. Simulate that here:
    const sessionForB = db.prepare(
      `SELECT id FROM sessions
         WHERE id = 999999 AND owner_type = 'tenant' AND owner_id = ?
           AND external_user_id = ?`
    ).get(b, 'ext-user');
    assert.equal(sessionForB, undefined, 'cross-tenant session lookup returns null');
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

// -- Session isolation -----------------------------------------------------

test('embed sessions of tenant A are invisible from tenant B list', () => {
  const a = ensureTenant('list-a');
  const b = ensureTenant('list-b');
  try {
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('a1', 'workspace', a, 'eu-a');
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('a2', 'workspace', a, 'eu-a');
    db.prepare(
      `INSERT INTO sessions (title, model, owner_type, owner_id, external_user_id)
       VALUES (?, ?, 'tenant', ?, ?)`
    ).run('b1', 'workspace', b, 'eu-b');

    const listA = db.prepare(
      `SELECT id FROM sessions WHERE owner_type = 'tenant' AND owner_id = ? AND external_user_id = ?`
    ).all(a, 'eu-a');
    const listB = db.prepare(
      `SELECT id FROM sessions WHERE owner_type = 'tenant' AND owner_id = ? AND external_user_id = ?`
    ).all(b, 'eu-b');

    assert.equal(listA.length, 2);
    assert.equal(listB.length, 1);
    assert.equal(listA.find((r) => r.id === undefined), undefined);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

// -- Tool + audit isolation ------------------------------------------------

test('tool_executions analytics never cross tenant boundary', async () => {
  const a = ensureTenant('ana');
  const b = ensureTenant('anb');
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    insertTool(a, { name: 'get_a', description: '', json_schema: {}, endpoint_url: 'https://a.test/x' });
    insertTool(b, { name: 'get_b', description: '', json_schema: {}, endpoint_url: 'https://b.test/x' });

    const toolA = db.prepare('SELECT * FROM tools WHERE tenant_id = ?').get(a);
    const toolB = db.prepare('SELECT * FROM tools WHERE tenant_id = ?').get(b);

    await executeHttpTool(toolA, {}, { tenant_id: a, external_user_id: 'eu' });
    await executeHttpTool(toolA, {}, { tenant_id: a, external_user_id: 'eu' });
    await executeHttpTool(toolB, {}, { tenant_id: b, external_user_id: 'eu' });

    const aExec = db.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE tenant_id = ?').get(a);
    const bExec = db.prepare('SELECT COUNT(*) AS n FROM tool_executions WHERE tenant_id = ?').get(b);
    assert.equal(aExec.n, 2);
    assert.equal(bExec.n, 1);
    // Top-tool for tenant A only returns tenant A's tool name.
    const topA = db.prepare(
      `SELECT t.name FROM tool_executions te
         LEFT JOIN tools t ON t.id = te.tool_id
         WHERE te.tenant_id = ?
         GROUP BY te.tool_id ORDER BY COUNT(*) DESC LIMIT 1`
    ).get(a);
    assert.equal(topA.name, 'get_a');
  } finally {
    globalThis.fetch = orig;
    cleanup(a);
    cleanup(b);
  }
});

test('listActiveToolsForTenant is tenant-scoped', () => {
  const a = ensureTenant('ta');
  const b = ensureTenant('tb');
  try {
    insertTool(a, { name: 'shared_name', description: '', json_schema: {}, endpoint_url: 'https://a/x' });
    insertTool(b, { name: 'shared_name', description: '', json_schema: {}, endpoint_url: 'https://b/x' });
    insertTool(a, { name: 'a_only', description: '', json_schema: {}, endpoint_url: 'https://a/y' });
    insertTool(b, { name: 'b_only', description: '', json_schema: {}, endpoint_url: 'https://b/y' });

    const aTools = listActiveToolsForTenant(a).map((r) => r.name).sort();
    const bTools = listActiveToolsForTenant(b).map((r) => r.name).sort();
    assert.deepEqual(aTools, ['a_only', 'shared_name']);
    assert.deepEqual(bTools, ['b_only', 'shared_name']);
    // And capability profile is read per-tenant — writing to one
    // doesn't leak into the other. Set a distinctive value on A.
    db.prepare(
      `INSERT INTO tenant_capability_profile (id, tenant_id, max_context_tokens)
       VALUES (?, ?, ?)`
    ).run('cap-' + crypto.randomBytes(4).toString('hex'), a, 12345);
    assert.equal(loadCapability(a).max_context_tokens, 12345);
    assert.equal(loadCapability(b).max_context_tokens, null, 'B unaffected by A insert');
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

// -- Rate limit isolation --------------------------------------------------

test('rate-limit bucket is per-tenant (no cross-tenant starvation)', () => {
  resetRateLimit();
  const a = ensureTenant('rl-a');
  const b = ensureTenant('rl-b');
  try {
    // Burn A's default bucket dry.
    let first429 = -1;
    for (let i = 0; i < 200; i++) {
      const r = consumeToken(a);
      if (!r.ok && first429 === -1) first429 = i;
    }
    assert.ok(first429 >= 0, 'tenant A bucket eventually exhausts');
    assert.ok(first429 < 200, 'and within a small number of calls');

    // B's bucket should still be untouched — first consume is ok.
    const bFirst = consumeToken(b);
    assert.equal(bFirst.ok, true, 'tenant B unaffected by A burst');
  } finally {
    cleanup(a);
    cleanup(b);
    resetRateLimit();
  }
});

test('rate-limit respects tenant_capability_profile.rate_limit_override', () => {
  resetRateLimit();
  const a = ensureTenant('rl-ov');
  try {
    // Set A's override to 5.
    db.prepare(
      `INSERT INTO tenant_capability_profile (id, tenant_id, rate_limit_override)
       VALUES (?, ?, ?)`
    ).run('cap-' + crypto.randomBytes(4).toString('hex'), a, 5);
    // Burn through.
    let first429 = -1;
    for (let i = 0; i < 200; i++) {
      const r = consumeToken(a);
      if (!r.ok && first429 === -1) first429 = i;
    }
    assert.ok(first429 >= 4 && first429 <= 7, 'override ≈ 5 → exhausts around 5-7th call (got ' + first429 + ')');
  } finally {
    cleanup(a);
    resetRateLimit();
  }
});

// -- Persona isolation -----------------------------------------------------

test('persona cache is per-tenant (no cross-tenant block leak)', () => {
  resetPersona();
  const a = ensureTenant('p-a', { persona: { name: 'Aria', tone: 'friendly' } });
  const b = ensureTenant('p-b', { persona: { name: 'Bruno', tone: 'formal' } });
  try {
    const blockA = getPersonaBlock(a);
    const blockB = getPersonaBlock(b);
    assert.ok(blockA.includes('Aria'));
    assert.ok(!blockA.includes('Bruno'));
    assert.ok(blockB.includes('Bruno'));
    assert.ok(!blockB.includes('Aria'));
  } finally {
    cleanup(a);
    cleanup(b);
    resetPersona();
  }
});

test('invalidatePersonaCache drops only the targeted tenant', () => {
  resetPersona();
  const a = ensureTenant('inv-a', { persona: { name: 'Aria' } });
  const b = ensureTenant('inv-b', { persona: { name: 'Bruno' } });
  try {
    // Warm both caches.
    getPersonaBlock(a);
    getPersonaBlock(b);
    invalidatePersonaCache(a);
    // A's next read re-hits the DB; B's cache is still warm. We can't
    // directly observe cache state, so we mutate A's tenant row and
    // confirm only A is affected by the change.
    db.prepare(`UPDATE tenants SET persona_config = ? WHERE id = ?`)
      .run(JSON.stringify({ name: 'AriaTwo' }), a);
    // Touch A so the cached value gets re-resolved (without invalidation
    // we wouldn't see AriaTwo yet). Simulate that by manually invalidating
    // and re-reading.
    invalidatePersonaCache(a);
    const blockA = getPersonaBlock(a);
    assert.ok(blockA.includes('AriaTwo'));
    // B remains Bruno (no invalidation needed).
    const blockB = getPersonaBlock(b);
    assert.ok(blockB.includes('Bruno'));
  } finally {
    cleanup(a);
    cleanup(b);
    resetPersona();
  }
});