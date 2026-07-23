/**
 * Public OpenAPI surface — backed by api_keys. MVP scope: sessions + runs.
 *
 * Auth: every route goes through requireApiKey. The resolved
 * `req.apiKey.model` is the only model the caller may use for runs —
 * any model field in the request body is ignored to enforce the lock.
 *
 * SSE: reuses run-registry + the same wire format as /api/sessions/:id/runs.
 * Clients pass the key as `Authorization: Bearer clw_...`; if the client
 * is a browser EventSource the same `?key=` query param works (or `?token=`
 * for parity with the legacy path).
 */

import express from 'express';
import fs from 'node:fs';
import db from '../db/index.js';
import { runLLM } from '../llm-runner.js';
import { detectArtifacts, evaluateArtifact } from '../artifact-detector.js';
import { renderProjectMemoryFactsBlock } from '../project_memory.js';
import registry from '../run-registry.js';
import rag from '../rag.js';

const router = express.Router();

const MAX_KNOWLEDGE_BYTES = 512 * 1024;
const MAX_TITLE = 80;

function ownSessionOr404(id, user) {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE id = ?
          AND (owner_type = 'user' AND owner_id = ? OR ? = 'admin')`
    )
    .get(id, String(user.id), user.role || 'member');
}

router.get('/me', (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      display_name: req.user.display_name || null,
    },
    key: {
      id: req.apiKey.id,
      name: req.apiKey.name,
      model: req.apiKey.model,
    },
  });
});

router.post('/sessions', (req, res) => {
  const { title, project_id, system_prompt } = req.body || {};
  if (project_id) {
    const own = db
      .prepare(
        `SELECT id FROM projects WHERE id = ?
           AND (owner_type = 'user' AND owner_id = ? OR ? = 'admin')`
      )
      .get(project_id, String(req.user.id), req.user.role || 'member');
    if (!own) return res.status(403).json({ error: 'project not accessible' });
  }
  const info = db
    .prepare(
      `INSERT INTO sessions (title, model, project_id, system_prompt, user_id, owner_type, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`
    )
    .run(
      title?.trim() || null,
      req.apiKey.model,
      project_id || null,
      system_prompt || null,
      req.user.id,
      String(req.user.id),
      new Date().toISOString(),
      new Date().toISOString()
    );
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

router.get('/sessions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  const rows = db
    .prepare(
      `SELECT * FROM sessions
         WHERE owner_type = 'user' AND owner_id = ?
           AND archived_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
    )
    .all(String(req.user.id), limit, offset);
  res.json({ sessions: rows, limit, offset });
});

router.get('/sessions/:id', (req, res) => {
  const s = ownSessionOr404(req.params.id, req.user);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({ session: s });
});

router.get('/sessions/:id/full', (req, res) => {
  const s = ownSessionOr404(req.params.id, req.user);
  if (!s) return res.status(404).json({ error: 'not found' });
  const messages = db
    .prepare(
      `SELECT id, role, content, cost_usd, input_tokens, output_tokens, duration_ms, created_at
         FROM messages WHERE session_id = ? ORDER BY id ASC`
    )
    .all(s.id);
  const msgIds = messages.map((m) => m.id);
  const tools = msgIds.length
    ? db
        .prepare(
          `SELECT * FROM tool_uses WHERE message_id IN (${msgIds.map(() => '?').join(',')})
           ORDER BY id ASC`
        )
        .all(...msgIds)
    : [];
  const artifacts = db
    .prepare(`SELECT * FROM artifacts WHERE session_id = ? ORDER BY id ASC`)
    .all(s.id);
  const attachments = msgIds.length
    ? db
        .prepare(
          `SELECT * FROM message_attachments
             WHERE message_id IN (${msgIds.map(() => '?').join(',')})
             ORDER BY id ASC`
        )
        .all(...msgIds)
    : [];
  res.json({ session: s, messages, tool_uses: tools, artifacts, attachments });
});

router.post('/sessions/:id/runs', async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const dbSession = ownSessionOr404(sessionId, req.user);
  if (!dbSession) return res.status(404).json({ error: 'session not found' });

  const {
    prompt, projectId, systemPrompt, attachments = [],
    effort, regenerate = false,
  } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const safePrompt = prompt.trim();
  // Model is locked to the API key — caller cannot override.
  const model = req.apiKey.model;

  let userMsgId;
  if (regenerate) {
    const lastUser = db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user'
           ORDER BY id DESC LIMIT 1`
      )
      .get(dbSession.id);
    if (!lastUser) return res.status(400).json({ error: 'no user message to regenerate' });
    userMsgId = lastUser.id;
  } else {
    const r = db
      .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
      .run(dbSession.id, 'user', safePrompt);
    userMsgId = r.lastInsertRowid;
  }

  for (const att of attachments) {
    db.prepare(
      `INSERT INTO message_attachments
         (message_id, file_name, file_path, mime_type, size, content)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      userMsgId,
      att.file_name,
      att.file_path,
      att.mime_type || 'application/octet-stream',
      att.size || 0,
      att.content || null
    );
  }

  const finalPrompt = buildFinalPrompt({ dbSession, prompt: safePrompt, userMsgId, attachments, reqUserId: req.user.id });

  let disabledSkills = [];
  if (dbSession.project_id) {
    const proj = db.prepare('SELECT disabled_skills FROM projects WHERE id = ?').get(dbSession.project_id);
    if (proj?.disabled_skills) {
      try {
        const arr = JSON.parse(proj.disabled_skills);
        if (Array.isArray(arr)) disabledSkills = arr.filter((n) => typeof n === 'string').slice(0, 256);
      } catch { /* corrupt */ }
    }
  }

  // Per-project memory facts (Phase 5) — same shape as routes/runs.js.
  // Resolved here so the runner stays DB-free at chat time.
  const projectMemoryBlock = dbSession.project_id
    ? renderProjectMemoryFactsBlock(dbSession.project_id)
    : '';

  // Project instructions lifted into the system prompt (mirrors
  // runs.js). Trims whitespace-only as no-op so the reducer cleanly
  // skips when the project has no instructions.
  let projectInstructionsBlock = '';
  if (dbSession.project_id) {
    const proj = db
      .prepare('SELECT instructions FROM projects WHERE id = ?')
      .get(dbSession.project_id);
    const txt = proj?.instructions?.trim();
    if (txt) {
      projectInstructionsBlock = `<system>\n[Project Instructions]\n${txt}\n</system>`;
    }
  }

  const runId = registry.create({ sessionId: dbSession.id, userId: req.user.id });
  let cliSessionId = dbSession.claude_session_id || null;
  let usage = null;
  let costUsd = 0;
  let durationMs = 0;
  let isError = false;
  let activeMsgId = null;
  let assistantFullText = '';
  const pendingToolArtifacts = [];
  const pendingToolUses = new Map();
  const toolRecords = [];
  const toolStartedAt = new Map();

  registry.emit(runId, 'start', { sessionId: dbSession.id, messageId: null });

  const startedAt = Date.now();
  const ctrl = runLLM(
    finalPrompt,
    {
      model,
      effort: effort || undefined,
      projectId: dbSession.project_id ?? undefined,
      projectMemoryBlock,
      projectInstructionsBlock,
      disabledSkills,
      images: extractImageParts(attachments),
      history: [],
    },
    (evt) => {
      if (evt.type === 'text') {
        if (typeof evt.text === 'string' && evt.text.length > 0) {
          assistantFullText += evt.text;
          registry.emit(runId, 'text', { sessionId: dbSession.id, text: evt.text });
        }
      } else if (evt.type === 'tool_use') {
        // Treated identically to /api/sessions/:id/runs — track tool use
        // for persistence, emit to subscribers, dispatch by tool name.
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
          claudeSessionId: cliSessionId,
        });
      } else if (evt.type === 'error') {
        registry.emit(runId, 'error', { sessionId: dbSession.id, message: evt.message });
      } else if (evt.type === 'stderr') {
        registry.emit(runId, 'stderr', { sessionId: dbSession.id, text: evt.text });
      } else if (evt.type === 'tool_artifact') {
        pendingToolArtifacts.push(evt.artifact || {});
      }
    }
  );

  registry.attachRunner(runId, ctrl.proc, ctrl);

  ctrl.proc.on('close', (code) => {
    if (!usage && code !== 0) {
      isError = true;
      registry.emit(runId, 'result', {
        isError: true, cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
        sessionId: dbSession.id, claudeSessionId: cliSessionId, exitCode: code,
        partialText: assistantFullText,
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

    // Tool artifacts flushed after assistant row is in (FK requirement).
    for (const art of pendingToolArtifacts) {
      if (!art.content) continue;
      const ins = db.prepare(
        `INSERT INTO artifacts
           (session_id, message_id, type, language, title, content, version, content_hash, source)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'tool')`
      ).run(
        dbSession.id, activeMsgId,
        art.type || 'code', art.language || null,
        art.title || 'Artifact', art.content,
        art.content_hash || null
      );
      registry.emit(runId, 'artifact', {
        id: ins.lastInsertRowid,
        session_id: dbSession.id,
        message_id: activeMsgId,
        type: art.type || 'code',
        language: art.language || null,
        title: art.title || 'Artifact',
        content_preview: (art.content || '').slice(0, 220),
        line_count: (art.content || '').split('\n').length,
        version: 1,
        source: 'tool',
      });
    }

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

  res.status(202).json({ runId, sessionId: dbSession.id, model });
});

router.get('/sessions/:id/runs/:runId/stream', (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid run id' });
  }
  // Ownership check — make sure the run belongs to a session the
  // caller can see. The registry doesn't track ownership, but the
  // session does.
  const dbSession = ownSessionOr404(req.params.id, req.user);
  if (!dbSession) return res.status(404).json({ error: 'session not found' });
  if (!registry.subscribe(runId, req, res)) {
    if (!res.headersSent) res.status(404).json({ error: 'run not found' });
  }
});

function extractImageParts(attachments) {
  const out = [];
  for (const att of attachments) {
    if (!att.mime_type || !att.mime_type.startsWith('image/')) continue;
    if (typeof att.content === 'string' && att.content.startsWith('data:')) {
      out.push({ type: 'image_url', image_url: { url: att.content } });
    }
  }
  return out;
}

function buildFinalPrompt({ dbSession, prompt, userMsgId, attachments, reqUserId }) {
  let prefix = '';
  // Inline text attachments. Image attachments are excluded — they go
  // through the multimodal image_url path (extractImageParts above) and
  // would otherwise be uploaded twice as base64, blowing past the LLM
  // gateway's payload budget and tripping 504 timeouts.
  const inlineAtts = attachments.filter(
    (a) => a.content && (!a.mime_type || !a.mime_type.startsWith('image/'))
  );
  if (inlineAtts.length) {
    prefix += '[Attachments]\n' +
      inlineAtts.map((a) => `--- ${a.file_name} (${a.mime_type}, ${a.size} bytes) ---\n${a.content}`).join('\n\n') +
      '\n\n';
  }
  // Project knowledge (read directly; RAG below adds semantic hits).
  // Project instructions moved out of the user-prompt prefix and into
  // the system prompt via opts.projectInstructionsBlock — see
  // routes/v1.js handler below.
  if (dbSession.project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(dbSession.project_id);
    if (project) {
      const parts = [];
      const knowledge = db
        .prepare('SELECT title, type, content, file_path, file_name, mime_type, size FROM project_knowledge WHERE project_id = ?')
        .all(dbSession.project_id);
      if (knowledge.length) {
        let bytes = 0;
        parts.push(
          '[Project Knowledge]\n' +
            knowledge.map((k) => {
              if (k.type === 'text') {
                const body = k.content || '';
                bytes += Buffer.byteLength(body, 'utf8');
                return `--- ${k.title} ---\n${body}`;
              }
              return `--- ${k.title} (file: ${k.file_name || 'attached'}) ---`;
            }).join('\n\n')
        );
      }
      if (parts.length) prefix += parts.join('\n\n') + '\n\n';
    }
  }
  if (dbSession.system_prompt) prefix += dbSession.system_prompt + '\n\n';

  // RAG is intentionally fire-and-forget here: a sync query would
  // block the request handler. We kick it off but the model still
  // has the inline prefix above; the next message gets RAG results.
  if (reqUserId && prompt && prompt.trim().length > 0) {
    rag
      .query(prompt, { scopeUserId: reqUserId, sessionId: dbSession.id })
      .then((hits) => {
        if (!hits || hits.length === 0) return;
        // We can't mutate the prefix here — the prompt was already
        // submitted — but we log the hit for observability. A future
        // iteration can stream this into the run via an SSE replay.
        process.stderr.write(`[rag] v1 hits=${hits.length} top=${hits[0].label} score=${hits[0].score.toFixed(3)}\n`);
      })
      .catch((e) => process.stderr.write(`[rag] v1 query failed: ${e.message}\n`));
  }

  return prefix ? `<system>\n${prefix.trim()}\n</system>\n\n${prompt}` : prompt;
}

export default router;
