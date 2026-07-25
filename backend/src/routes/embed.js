/**
 * Embed-mode routes — browser widget API surface.
 *
 * Two concerns under one router, mounted at /api/embed:
 *   1. POST /api/embed/token      — server-to-server, requireTenantApiKey
 *      trades a long-lived tenant_api_key for a short-lived embed_token.
 *
 *   2. POST /api/embed/sessions   — browser, requireEmbedToken
 *      GET  /api/embed/sessions/:id
 *      GET  /api/embed/sessions/:id/full
 *      POST /api/embed/sessions/:id/runs
 *      GET  /api/embed/sessions/:id/runs/:runId/stream   (SSE)
 *      POST /api/embed/sessions/:id/runs/:runId/stop
 *
 * Trust boundary:
 *   - Tenant must be active. req.embed is fully populated before any
 *     handler runs.
 *   - Sessions are scoped to (owner_type='tenant', owner_id=tenant_id,
 *     external_user_id). A widget never sees another tenant's session
 *     even if it guesses the row id correctly.
 *   - The model key is locked to the tenant's default_model_id (looked
 *     up via JOIN on models). Callers cannot pass their own model.
 *
 * Capability gating (allow_artifact_generation, allow_bash, allowed
 * tools) lands in E3/E4 alongside tenant_capability_profile + tools.
 * For E2 the embed runner is read-only-ish: same engine, same system
 * prompt, no project context, no RAG. Persona_config is honored as a
 * system-prompt append (cheap + already enough to make a tenant's bot
 * feel distinct) — full E5 persona work wraps analytics + a custom
 * greeting on top of this.
 */

import express from 'express';
import db from '../db/index.js';
import { runLLM } from '../llm-runner.js';
import registry from '../run-registry.js';
import { issueEmbedToken } from '../embed-token.js';
import { requireTenantApiKey } from '../middleware/tenant-api-key.js';
import { requireEmbedToken } from '../middleware/embed-token.js';
import { resolveEmbedTools } from '../embed-tool-registry.js';
import { findToolByName, executeHttpTool, createPendingExecution, loadCapability } from '../tool-executor.js';
import { ensureEmbedWorkdir } from '../embed-workdir.js';
import { getPersonaBlock, buildEmbedPrompt } from '../persona.js';
import { makeRateLimitMiddleware } from '../rate-limit.js';

const router = express.Router();

// Rate limit middleware (per-tenant token bucket). Applied AFTER
// requireEmbedToken so the bucket key is the verified tenant_id.
// Cheap (in-memory map lookup) so the latency cost is negligible.
const embedRateLimit = makeRateLimitMiddleware();

// ---- /api/embed/token — server-to-server token issuance -------------

router.post('/token', requireTenantApiKey, (req, res) => {
  const { external_user_id } = req.body || {};
  if (!external_user_id || typeof external_user_id !== 'string') {
    return res.status(400).json({ error: 'external_user_id is required' });
  }
  // Bound the id so a hostile caller can't blow the row size. Tenant
  // apps typically use a numeric or uuid-like string.
  const safeExternalId = external_user_id.trim().slice(0, 200);
  if (safeExternalId.length === 0) {
    return res.status(400).json({ error: 'external_user_id is empty' });
  }
  const issued = issueEmbedToken(req.tenant.id, safeExternalId);
  res.json({
    embed_token: issued.embed_token,
    expires_at: issued.expires_at,
    tenant_id: req.tenant.id,
    external_user_id: safeExternalId,
    persona_config: req.tenant.persona_config || null,
  });
});

// ---- /api/embed/sessions — widget-facing chat surface ----------------
// Everything below this line requires an embed token. The route mounts
// `requireEmbedToken` on each handler individually so the token-issuance
// route above stays exempt (server-to-server auth, not embed auth).

function resolveModelKey(tenant) {
  if (!tenant.default_model_id) return 'workspace';
  const row = db
    .prepare('SELECT key FROM models WHERE id = ? AND enabled = 1')
    .get(tenant.default_model_id);
  return row?.key || 'workspace';
}

/**
 * Build the dispatcher the llm-runner calls for Kategori B tool
 * invocations. Flow:
 *   1. Look up the tool row by name (tenant-scoped).
 *   2. If it requires confirmation, emit a 'tool_pending_confirmation'
 *      SSE event with the params; the widget renders a confirm UI.
 *      For now (auto-confirm) we just write a pending audit row and
 *      proceed — full widget-side handshake is queued behind the
 *      widget UI work (E3.4).
 *   3. Run executeHttpTool which validates, signs, POSTs, and writes
 *      the executed/failed audit row.
 *   4. Return shape matches runTool's: { text, error? }.
 */
function makeEmbedToolDispatcher({ tenantId, externalUserId, requiresConfirmation, runId }) {
  return async function dispatch(toolName, params, ctx) {
    const tool = findToolByName(tenantId, toolName);
    if (!tool) {
      return { error: `tool "${toolName}" not active for this tenant` };
    }
    if (requiresConfirmation.has(toolName)) {
      const pendingId = createPendingExecution({
        toolId: tool.id,
        tenantId,
        externalUserId,
        messageId: null,            // user message id not yet bound at this point in the loop
        params,
      });
      try {
        registry.emit(runId, 'tool_pending_confirmation', {
          tool: { id: tool.id, name: tool.name, description: tool.description },
          params,
          execution_id: pendingId,
        });
      } catch { /* ignore — SSE may already be closed */ }
    }
    const result = await executeHttpTool(tool, params, {
      tenant_id: tenantId,
      external_user_id: externalUserId,
      message_id: ctx?.session_id ? null : null,
    });
    if (!result.ok) return { error: result.error };
    return { text: JSON.stringify(result.output) };
  };
}

function loadEmbedSession(sessionId, embed) {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE id = ?
          AND owner_type = 'tenant' AND owner_id = ?
          AND external_user_id = ?`
    )
    .get(sessionId, embed.tenant_id, embed.external_user_id);
}

router.post('/sessions', requireEmbedToken, embedRateLimit, (req, res) => {
  const modelKey = resolveModelKey(req.embed);
  // Per-tenant workdir so Kategori A tools (Read/Write/Edit/Bash) are
  // sandboxed to a directory unique to (tenant, external_user_id).
  // Lazily created — the model never sees the directory path unless it
  // asks via Bash/Read.
  const workdir = ensureEmbedWorkdir(req.embed.tenant_id, req.embed.external_user_id);
  const info = db
    .prepare(
      `INSERT INTO sessions
         (title, model, user_id, workdir, owner_type, owner_id, external_user_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'tenant', ?, ?, ?, ?)`
    )
    .run(
      'New chat',
      modelKey,
      workdir,
      req.embed.tenant_id,
      req.embed.external_user_id,
      new Date().toISOString(),
      new Date().toISOString()
    );
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(info.lastInsertRowid);
  res.status(201).json({ session: row, model: modelKey });
});

router.get('/sessions/:id', requireEmbedToken, embedRateLimit, (req, res) => {
  const s = loadEmbedSession(req.params.id, req.embed);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ session: s });
});

router.get('/sessions/:id/full', requireEmbedToken, embedRateLimit, (req, res) => {
  const s = loadEmbedSession(req.params.id, req.embed);
  if (!s) return res.status(404).json({ error: 'not found' });
  const messages = db
    .prepare(
      `SELECT id, role, content, cost_usd, input_tokens, output_tokens, duration_ms, created_at
         FROM messages WHERE session_id = ? ORDER BY id ASC`
    )
    .all(s.id);
  const msgIds = messages.map((m) => m.id);
  const artifacts = msgIds.length === 0
    ? []
    : db
        .prepare(
          `SELECT * FROM artifacts WHERE session_id = ?
             ORDER BY id ASC`
        )
        .all(s.id);
  res.json({
    session: s,
    messages,
    artifacts,
    tenant: {
      id: req.embed.tenant_id,
      slug: req.embed.tenant_slug,
      name: req.embed.tenant_name,
      persona_config: req.embed.persona_config,
    },
  });
});

router.post('/sessions/:id/runs', requireEmbedToken, embedRateLimit, async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const dbSession = loadEmbedSession(sessionId, req.embed);
  if (!dbSession) return res.status(404).json({ error: 'session not found' });

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const safePrompt = prompt.trim();
  if (safePrompt.length === 0) {
    return res.status(400).json({ error: 'prompt is empty' });
  }

  // Persist user message.
  const userMsg = db
    .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
    .run(dbSession.id, 'user', safePrompt);
  const userMsgId = userMsg.lastInsertRowid;

  // Persona block — cached per tenant. If no persona is configured,
  // getPersonaBlock returns null and buildEmbedPrompt skips it.
  // Inline override (dbSession.system_prompt) is appended as a second
  // <system> block so persona stays the primary voice.
  const personaBlock = getPersonaBlock(req.embed.tenant_id);
  const finalPrompt = buildEmbedPrompt({
    personaBlock,
    systemPromptOverride: dbSession.system_prompt,
    userPrompt: safePrompt,
  });

  const runId = registry.create({ sessionId: dbSession.id, userId: null });

  // Resolve the dynamic tool set for this tenant. Capability profile
  // (allow_artifact_generation, allow_bash) is loaded but only the
  // tools list affects the LLM right now — Kategori A enforcement lands
  // in E4 alongside the workdir sandbox.
  const { tools: embedTools, requiresConfirmation, capability } = resolveEmbedTools(req.embed.tenant_id);

  let cliSessionId = dbSession.claude_session_id || null;
  let usage = null;
  let costUsd = 0;
  let durationMs = 0;
  let isError = false;
  let activeMsgId = null;
  let assistantFullText = '';

  registry.emit(runId, 'start', {
    sessionId: dbSession.id,
    messageId: null,
    embed: {
      tenant_id: req.embed.tenant_id,
      external_user_id: req.embed.external_user_id,
      tools: embedTools.map((t) => t.function.name),
      requires_confirmation: requiresConfirmation,
      capability: {
        allow_artifact_generation: capability.allow_artifact_generation,
        allow_bash: capability.allow_bash,
      },
    },
  });

  let ctrl;
  try {
    ctrl = runLLM(
      finalPrompt,
      {
        model: dbSession.model,
        userId: null,                // platform system prompt is irrelevant for embed
        effort: undefined,
        history: [],
        embedTools,                   // Kategori B tools for this tenant
        embedDispatch: makeEmbedToolDispatcher({
          tenantId: req.embed.tenant_id,
          externalUserId: req.embed.external_user_id,
          requiresConfirmation: new Set(requiresConfirmation),
          runId,
        }),
        sessionId: dbSession.id,      // used by tool-loop bookkeeping
        tenantId: req.embed.tenant_id,
        externalUserId: req.embed.external_user_id,
        capability,                    // allow_artifact_generation / allow_bash
      },
      (evt) => {
        if (evt.type === 'text' && typeof evt.text === 'string' && evt.text.length > 0) {
          assistantFullText += evt.text;
          registry.emit(runId, 'text', { sessionId: dbSession.id, text: evt.text });
        } else if (evt.type === 'result') {
          usage = evt.usage || null;
          costUsd = evt.total_cost_usd || 0;
          durationMs = evt.duration_ms || 0;
          isError = !!evt.is_error;
          registry.emit(runId, 'result', {
            isError,
            errorMessage: isError ? (evt.result || evt.error || 'engine returned is_error=true') : undefined,
            cost: costUsd,
            durationMs,
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            sessionId: dbSession.id,
          });
        } else if (evt.type === 'error') {
          registry.emit(runId, 'error', { sessionId: dbSession.id, message: evt.message });
        } else if (evt.type === 'stderr') {
          registry.emit(runId, 'stderr', { sessionId: dbSession.id, text: evt.text });
        }
      }
    );
  } catch (err) {
    return res.status(500).json({ error: 'failed to start run', detail: err.message });
  }

  if (!ctrl || !ctrl.proc) {
    return res.status(500).json({ error: 'runner did not initialize' });
  }
  registry.attachRunner(runId, ctrl.proc, ctrl);

  ctrl.proc.on('close', (code) => {
    if (!usage && code !== 0) {
      isError = true;
      registry.emit(runId, 'result', {
        isError: true, cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
        sessionId: dbSession.id, exitCode: code, partialText: assistantFullText,
      });
    }
    const ai = db
      .prepare(
        `INSERT INTO messages
          (session_id, role, content, cost_usd, input_tokens, output_tokens, duration_ms)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?)`
      )
      .run(dbSession.id, assistantFullText, costUsd, usage?.input_tokens || 0, usage?.output_tokens || 0, durationMs);
    activeMsgId = ai.lastInsertRowid;
    registry.emit(runId, 'message_saved', { messageId: activeMsgId });

    db.prepare(
      `UPDATE sessions
         SET claude_session_id = COALESCE(?, claude_session_id),
             total_cost_usd   = total_cost_usd + ?,
             total_tokens     = total_tokens + ?,
             updated_at       = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(cliSessionId, costUsd, (usage?.input_tokens || 0) + (usage?.output_tokens || 0), dbSession.id);

    registry.emit(runId, 'done', {
      sessionId: dbSession.id,
      messageId: activeMsgId,
      isError,
      resumable: !!isError && !!cliSessionId,
      claudeSessionId: cliSessionId || null,
      exitCode: code,
      partialText: isError ? assistantFullText : null,
    });
    registry.end(runId);
  });

  res.status(202).json({ runId, sessionId: dbSession.id, model: dbSession.model });
});

router.get('/sessions/:id/runs/:runId/stream', requireEmbedToken, embedRateLimit, (req, res) => {
  const sessionId = Number(req.params.id);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid run id' });
  }
  const dbSession = loadEmbedSession(sessionId, req.embed);
  if (!dbSession) return res.status(404).json({ error: 'session not found' });
  if (!registry.subscribe(runId, req, res)) {
    if (!res.headersSent) res.status(404).json({ error: 'run not found' });
  }
});

router.post('/sessions/:id/runs/:runId/stop', requireEmbedToken, embedRateLimit, (req, res) => {
  const sessionId = Number(req.params.id);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid run id' });
  }
  const dbSession = loadEmbedSession(sessionId, req.embed);
  if (!dbSession) return res.status(404).json({ error: 'session not found' });
  const ok = registry.stop(runId);
  res.json({ ok });
});

export default router;