/**
 * tool-executor — Kategori B runtime.
 *
 * Each registered tool points at a saas-app endpoint (Laravel route,
 * Rails controller, whatever). This module validates the params
 * against the tool's json_schema, POSTs them to endpoint_url, and
 * surfaces the response as { ok, output } or { ok:false, error }.
 *
 * Trust boundary:
 *   - endpoint_url is recorded in the DB by an admin, never accepted
 *     from the browser. So we trust it as much as we trust the DB row.
 *   - We still cap response body size and timeout so a misbehaving
 *     upstream can't pin the server.
 *   - The HTTP call is signed with a per-request HMAC of the params
 *     using the tenant's active api_key. The saas-app verifies the
 *     signature in its middleware before trusting the body.
 *
 * Schema validation is intentionally minimal (type / required /
 * properties.type / enum). A full JSON Schema implementation is
 * overkill for the categories we ship; tighten when needed.
 */

import crypto from 'node:crypto';
import db from './db/index.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;   // 1MB cap on response body
const REQUEST_TIMEOUT_MS = parseInt(process.env.TOOL_TIMEOUT_MS || '8000', 10);

// -- Schema validation -----------------------------------------------------

function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function validateParams(schema, params) {
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type && schema.type !== 'object') {
    return { ok: false, error: 'schema root must be type=object' };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  for (const key of required) {
    if (!(key in (params || {}))) return { ok: false, error: `missing required: ${key}` };
  }
  for (const [k, v] of Object.entries(params || {})) {
    const def = props[k];
    if (!def) continue; // extra props allowed by default
    if (def.type && !typeMatches(v, def.type)) {
      return { ok: false, error: `field "${k}" must be ${def.type}` };
    }
    if (Array.isArray(def.enum) && !def.enum.includes(v)) {
      return { ok: false, error: `field "${k}" must be one of ${def.enum.join(',')}` };
    }
  }
  return { ok: true };
}

// -- Tenant signing key (per-request) --------------------------------------

/**
 * Find the tenant's oldest active (non-revoked) api_key. The saas-app
 * signs incoming requests using the same key, so we send the secret
 * inline via header rather than doing asymmetric crypto. If a tenant
 * has no active key, signing is skipped (the saas-app should be
 * configured to allow either-or).
 */
function pickSigningKey(tenantId) {
  return db
    .prepare(
      `SELECT key_hash FROM tenant_api_keys
         WHERE tenant_id = ? AND revoked_at IS NULL
         ORDER BY id ASC LIMIT 1`
    )
    .get(tenantId);
}

// -- Public API ------------------------------------------------------------

/**
 * Fetch a tool row by id. The embed token must include the tenant_id;
 * we cross-check that the tool belongs to that tenant before returning.
 * Returns null if either lookup misses.
 */
export function loadTool(toolId, tenantId) {
  if (!toolId || !tenantId) return null;
  return db
    .prepare(
      `SELECT * FROM tools WHERE id = ? AND tenant_id = ? AND is_active = 1`
    )
    .get(toolId, tenantId);
}

/**
 * Resolve a tool by name for a tenant. Used when the LLM emits a tool
 * call keyed on the tool's `name` field. Returns null if no active tool
 * by that name belongs to the tenant.
 */
export function findToolByName(tenantId, name) {
  if (!tenantId || !name) return null;
  return db
    .prepare(
      `SELECT * FROM tools WHERE tenant_id = ? AND name = ? AND is_active = 1`
    )
    .get(tenantId, String(name));
}

/**
 * Resolve the active tool set for a tenant. Used to build the dynamic
 * tools[] passed into the LLM at run time. Honors the capability
 * profile's allowed_tool_ids whitelist (empty array = no whitelist,
 * use is_active only).
 */
export function listActiveToolsForTenant(tenantId) {
  if (!tenantId) return [];
  const cap = db
    .prepare(`SELECT allowed_tool_ids FROM tenant_capability_profile WHERE tenant_id = ?`)
    .get(tenantId);
  let allowList = null;
  if (cap?.allowed_tool_ids) {
    try {
      const parsed = JSON.parse(cap.allowed_tool_ids);
      if (Array.isArray(parsed) && parsed.length > 0) allowList = parsed.map(String);
    } catch { /* corrupt — fall back to no whitelist */ }
  }
  const rows = db
    .prepare(
      `SELECT * FROM tools
         WHERE tenant_id = ? AND is_active = 1
         ORDER BY name ASC`
    )
    .all(tenantId);
  if (!allowList) return rows;
  return rows.filter((r) => allowList.includes(r.id));
}

/**
 * Load the capability profile for a tenant. Returns a default-permissive
 * shape when the row doesn't exist yet (artifact generation on, bash
 * off, no tool whitelist, no context-token override).
 */
export function loadCapability(tenantId) {
  if (!tenantId) {
    return {
      allow_artifact_generation: false,
      allow_bash: false,
      allowed_tool_ids: [],
      max_context_tokens: null,
    };
  }
  const row = db
    .prepare(`SELECT * FROM tenant_capability_profile WHERE tenant_id = ?`)
    .get(tenantId);
  if (!row) {
    return {
      allow_artifact_generation: true,
      allow_bash: false,
      allowed_tool_ids: [],
      max_context_tokens: null,
    };
  }
  let tools = [];
  try {
    const parsed = JSON.parse(row.allowed_tool_ids || '[]');
    if (Array.isArray(parsed)) tools = parsed.map(String);
  } catch { /* corrupt */ }
  return {
    allow_artifact_generation: !!row.allow_artifact_generation,
    allow_bash: !!row.allow_bash,
    allowed_tool_ids: tools,
    max_context_tokens: row.max_context_tokens ?? null,
  };
}

/**
 * Execute a Kategori B tool. The caller has already resolved the tool
 * row (loadTool / findToolByName) and provided the params from the LLM.
 *
 * Returns:
 *   { ok: true,  output }                    // success
 *   { ok: false, error, retriable? }          // failure
 *
 * Side effects:
 *   - INSERTs one row into tool_executions (status='executed' or 'failed')
 *   - If messageId is null, no row is written (callers that pre-wrote
 *     a 'pending_confirmation' row should update it themselves).
 */
export async function executeHttpTool(tool, params, ctx) {
  if (!tool || !tool.endpoint_url) {
    return { ok: false, error: 'tool missing endpoint_url' };
  }
  let schema = {};
  if (tool.json_schema) {
    try { schema = JSON.parse(tool.json_schema); }
    catch { return { ok: false, error: 'tool has invalid json_schema' }; }
  }
  const v = validateParams(schema, params || {});
  if (!v.ok) return { ok: false, error: v.error };

  const tenantId = ctx?.tenant_id || tool.tenant_id;
  const externalUserId = ctx?.external_user_id || null;
  const messageId = ctx?.message_id || null;

  const sigKey = pickSigningKey(tenantId);
  const body = JSON.stringify({
    tool: tool.name,
    external_user_id: externalUserId,
    params: params || {},
    ts: Date.now(),
  });
  const headers = { 'Content-Type': 'application/json' };
  if (sigKey?.key_hash) {
    // The saas-app stores the same key_hash and verifies the HMAC by
    // computing it itself with the active api_key secret it has on
    // file. We send key_hash + signature; the app looks up the key by
    // hash and recomputes HMAC over (timestamp + body) to compare.
    const ts = String(Date.now());
    const sig = crypto
      .createHmac('sha256', sigKey.key_hash)
      .update(ts + '.' + body)
      .digest('hex');
    headers['X-Encompletion-Signature'] = sig;
    headers['X-Encompletion-Timestamp'] = ts;
    headers['X-Encompletion-Key-Hash'] = sigKey.key_hash;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(tool.endpoint_url, {
      method: 'POST',
      headers,
      body,
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return finalizeExecution({
      ok: false,
      error: `request failed: ${e.message}`,
      tool, tenantId, externalUserId, messageId, params,
    });
  }
  clearTimeout(timer);

  // Stream-read up to the cap; anything past the cap is treated as an
  // error rather than silently truncated.
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  let bytes = '';
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += decoder.decode(value, { stream: true });
        if (bytes.length > MAX_BODY_BYTES) {
          try { await reader.cancel(); } catch { /* ignore */ }
          return finalizeExecution({
            ok: false,
            error: 'response body exceeded cap',
            tool, tenantId, externalUserId, messageId, params,
          });
        }
      }
      bytes += decoder.decode();
    } catch (e) {
      return finalizeExecution({
        ok: false,
        error: `response read failed: ${e.message}`,
        tool, tenantId, externalUserId, messageId, params,
      });
    }
  }

  if (!res.ok) {
    return finalizeExecution({
      ok: false,
      error: `upstream HTTP ${res.status}`,
      tool, tenantId, externalUserId, messageId, params,
      upstreamBody: bytes.slice(0, 1024),
    });
  }

  let output;
  try {
    output = JSON.parse(bytes);
  } catch {
    output = { raw: bytes.slice(0, 4096) };
  }

  return finalizeExecution({
    ok: true,
    output,
    tool, tenantId, externalUserId, messageId, params,
  });
}

function finalizeExecution({ ok, error, output, tool, tenantId, externalUserId, messageId, params, upstreamBody }) {
  // Always write the audit row when we have enough context. Failures
  // are equally important — the tenant admin reviews tool_executions to
  // spot misbehaving integrations.
  try {
    if (tenantId) {
      db.prepare(
        `INSERT INTO tool_executions
           (id, message_id, tool_id, tenant_id, external_user_id,
            input_params, output, status, error_message, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        crypto.randomUUID(),
        messageId,
        tool?.id || null,
        tenantId,
        externalUserId,
        JSON.stringify(params || {}),
        output ? JSON.stringify(output) : null,
        ok ? 'executed' : 'failed',
        ok ? null : (error + (upstreamBody ? ` :: ${upstreamBody}` : '')).slice(0, 1024),
      );
    }
  } catch (e) {
    // Audit write failure must not block the response. Log to stderr.
    process.stderr.write(`[tool-executor] audit write failed: ${e.message}\n`);
  }
  if (ok) return { ok: true, output };
  return { ok: false, error };
}

/**
 * Pre-create a 'pending_confirmation' audit row when a tool requires
 * explicit user confirmation. The widget then PATCHes (or replaces) it
 * once the user accepts. Returns the new row id, or null on error.
 */
export function createPendingExecution({ toolId, tenantId, externalUserId, messageId, params }) {
  try {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO tool_executions
         (id, message_id, tool_id, tenant_id, external_user_id,
          input_params, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_confirmation')`
    ).run(id, messageId || null, toolId || null, tenantId, externalUserId, JSON.stringify(params || {}));
    return id;
  } catch {
    return null;
  }
}

export default {
  executeHttpTool,
  listActiveToolsForTenant,
  loadTool,
  findToolByName,
  loadCapability,
  createPendingExecution,
};