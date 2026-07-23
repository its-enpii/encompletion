/**
 * Capability + execution tests (phase E3.5).
 *
 * Coverage:
 *  - Tool row → LLM definition conversion (resolveEmbedTools)
 *  - Capability profile defaults when row missing
 *  - Schema validation rejects missing/bad-typed params
 *  - Audit row written per successful HTTP tool execution
 *  - Audit row written on failed execution
 *  - requires_confirmation set collected for tools, omitted otherwise
 *  - listActiveToolsForTenant honors allowed_tool_ids whitelist
 *  - findToolByName is tenant-scoped (same name in two tenants)
 *
 * The HTTP executor is hit through executeHttpTool with a mocked fetch
 * monkey-patched via globalThis so we can simulate upstream behavior
 * without spinning up a real HTTP server.
 *
 * Run: node --test src/capability-execution.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const db = (await import('./db/index.js')).default;
const { resolveEmbedTools } = await import('./embed-tool-registry.js');
const {
  executeHttpTool, findToolByName, listActiveToolsForTenant,
  loadCapability, createPendingExecution,
} = await import('./tool-executor.js');

function ensureTenant(slug, opts = {}) {
  const id = 'tenant-' + slug + '-' + crypto.randomBytes(3).toString('hex');
  db.prepare(
    `INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)`
  ).run(id, opts.name || ('Tenant ' + slug), slug, opts.status || 'active');
  return id;
}

function insertTool(tenantId, fields) {
  const id = 'tool-' + crypto.randomBytes(4).toString('hex');
  db.prepare(
    `INSERT INTO tools
       (id, tenant_id, name, description, json_schema, endpoint_url, tool_category, requires_confirmation, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    fields.name,
    fields.description,
    JSON.stringify(fields.json_schema || { type: 'object', properties: {} }),
    fields.endpoint_url,
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
  db.prepare('DELETE FROM sessions WHERE owner_type = ? AND owner_id = ?').run('tenant', tenantId);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
}

// -- Tool → LLM defs ------------------------------------------------------

test('resolveEmbedTools converts tool rows to LLM function defs', () => {
  const tenantId = ensureTenant('conv');
  try {
    insertTool(tenantId, {
      name: 'get_invoice',
      description: 'Look up an invoice by id',
      json_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      endpoint_url: 'https://example.test/api/invoice',
      requires_confirmation: false,
    });
    insertTool(tenantId, {
      name: 'cancel_order',
      description: 'Cancel an order (sensitive)',
      json_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      endpoint_url: 'https://example.test/api/cancel',
      requires_confirmation: true,
    });
    insertTool(tenantId, {
      name: 'archived_tool',
      description: 'disabled',
      json_schema: {},
      endpoint_url: 'https://example.test/api/archived',
      is_active: false,
    });

    const { tools, requiresConfirmation, capability } = resolveEmbedTools(tenantId);
    assert.equal(tools.length, 2, 'inactive tools filtered out');
    const defNames = tools.map((t) => t.function.name).sort();
    assert.deepEqual(defNames, ['cancel_order', 'get_invoice']);
    assert.deepEqual(requiresConfirmation.sort(), ['cancel_order']);
    assert.equal(typeof capability.allow_artifact_generation, 'boolean');
    assert.equal(capability.allow_bash, false, 'default bash disallowed');
  } finally {
    cleanup(tenantId);
  }
});

test('default capability profile is permissive-but-bash-off', () => {
  const tenantId = ensureTenant('cap');
  try {
    const cap = loadCapability(tenantId);
    assert.equal(cap.allow_artifact_generation, true);
    assert.equal(cap.allow_bash, false);
    assert.deepEqual(cap.allowed_tool_ids, []);
    assert.equal(cap.max_context_tokens, null);
  } finally {
    cleanup(tenantId);
  }
});

test('allowed_tool_ids whitelist narrows the active set', () => {
  const tenantId = ensureTenant('wh');
  try {
    const a = insertTool(tenantId, { name: 'a', description: '', json_schema: {}, endpoint_url: 'https://e/a' });
    insertTool(tenantId, { name: 'b', description: '', json_schema: {}, endpoint_url: 'https://e/b' });
    const c = insertTool(tenantId, { name: 'c', description: '', json_schema: {}, endpoint_url: 'https://e/c' });

    db.prepare(
      `INSERT INTO tenant_capability_profile (id, tenant_id, allowed_tool_ids)
       VALUES (?, ?, ?)`
    ).run('cap-' + crypto.randomBytes(4).toString('hex'), tenantId, JSON.stringify([a, c]));

    const list = listActiveToolsForTenant(tenantId);
    const names = list.map((r) => r.name).sort();
    assert.deepEqual(names, ['a', 'c']);

    const resolved = resolveEmbedTools(tenantId).tools.map((t) => t.function.name).sort();
    assert.deepEqual(resolved, ['a', 'c']);
  } finally {
    cleanup(tenantId);
  }
});

// -- Schema validation ----------------------------------------------------

test('executeHttpTool rejects missing required field', async () => {
  const tenantId = ensureTenant('val');
  let lastStatus = null;
  const orig = globalThis.fetch;
  // No fetch should happen — schema validate fails first.
  globalThis.fetch = () => { lastStatus = 'fetched'; throw new Error('should not fetch'); };
  try {
    const toolId = insertTool(tenantId, {
      name: 'need_id',
      description: '',
      json_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      endpoint_url: 'https://example.test/api/need_id',
    });
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
    const r = await executeHttpTool(tool, { wrong: 'field' }, { tenant_id: tenantId, external_user_id: 'u1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing required: id/);
    assert.equal(lastStatus, null, 'fetch never called');
    // No audit row written when validation fails before any HTTP call.
    const rows = db.prepare('SELECT * FROM tool_executions WHERE tenant_id = ?').all(tenantId);
    assert.equal(rows.length, 0, 'no audit on pre-fetch validation failure');
  } finally {
    globalThis.fetch = orig;
    cleanup(tenantId);
  }
});

test('executeHttpTool rejects wrong-typed field', async () => {
  const tenantId = ensureTenant('typ');
  const orig = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('should not fetch'); };
  try {
    const toolId = insertTool(tenantId, {
      name: 'typed',
      description: '',
      json_schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
      endpoint_url: 'https://example.test/api/typed',
    });
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
    const r = await executeHttpTool(tool, { count: 'not-a-number' }, { tenant_id: tenantId, external_user_id: 'u1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /must be integer/);
  } finally {
    globalThis.fetch = orig;
    cleanup(tenantId);
  }
});

// -- Successful HTTP roundtrip (mocked) ----------------------------------

test('executeHttpTool writes an audit row on success', async () => {
  const tenantId = ensureTenant('ok');
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    return new Response(JSON.stringify({ invoice: { id: 'inv-1', total: 42 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const toolId = insertTool(tenantId, {
      name: 'get_invoice',
      description: '',
      json_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      endpoint_url: 'https://example.test/api/invoice',
    });
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
    const r = await executeHttpTool(tool, { id: 'inv-1' }, { tenant_id: tenantId, external_user_id: 'u-1' });
    assert.equal(r.ok, true);
    assert.equal(r.output.invoice.id, 'inv-1');

    const rows = db.prepare('SELECT * FROM tool_executions WHERE tenant_id = ?').all(tenantId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'executed');
    assert.equal(rows[0].external_user_id, 'u-1');
    assert.match(rows[0].input_params, /inv-1/);
  } finally {
    globalThis.fetch = orig;
    cleanup(tenantId);
  }
});

test('executeHttpTool writes a failed audit row on upstream 5xx', async () => {
  const tenantId = ensureTenant('fail');
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 503 });
  try {
    const toolId = insertTool(tenantId, {
      name: 'fragile',
      description: '',
      json_schema: {},
      endpoint_url: 'https://example.test/api/fragile',
    });
    const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
    const r = await executeHttpTool(tool, {}, { tenant_id: tenantId, external_user_id: 'u-2' });
    assert.equal(r.ok, false);
    assert.match(r.error, /503/);

    const rows = db.prepare('SELECT * FROM tool_executions WHERE tenant_id = ?').all(tenantId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.match(rows[0].error_message, /503/);
  } finally {
    globalThis.fetch = orig;
    cleanup(tenantId);
  }
});

// -- Cross-tenant isolation ----------------------------------------------

test('findToolByName is tenant-scoped', () => {
  const a = ensureTenant('iso-a');
  const b = ensureTenant('iso-b');
  try {
    insertTool(a, { name: 'get_user', description: '', json_schema: {}, endpoint_url: 'https://a.test/u' });
    insertTool(b, { name: 'get_user', description: '', json_schema: {}, endpoint_url: 'https://b.test/u' });

    const inA = findToolByName(a, 'get_user');
    const inB = findToolByName(b, 'get_user');
    assert.ok(inA, 'a has the tool');
    assert.ok(inB, 'b has the tool');
    assert.equal(inA.tenant_id, a);
    assert.equal(inB.tenant_id, b);

    // Wrong tenant → no match (so a tool can't be invoked cross-tenant).
    assert.equal(findToolByName(a, 'get_user')?.tenant_id, a);
    assert.equal(findToolByName('tenant-does-not-exist', 'get_user'), undefined);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

// -- Pending confirmation row --------------------------------------------

test('createPendingExecution writes a row in pending_confirmation', () => {
  const tenantId = ensureTenant('pend');
  try {
    const toolId = insertTool(tenantId, {
      name: 'sensitive_tool',
      description: '',
      json_schema: {},
      endpoint_url: 'https://example.test/api/sens',
      requires_confirmation: true,
    });
    const execId = createPendingExecution({
      toolId,
      tenantId,
      externalUserId: 'u-3',
      messageId: null,
      params: { amount: 1000 },
    });
    assert.ok(execId, 'returns id');

    const rows = db.prepare('SELECT * FROM tool_executions WHERE id = ?').all(execId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending_confirmation');
    assert.match(rows[0].input_params, /1000/);
  } finally {
    cleanup(tenantId);
  }
});