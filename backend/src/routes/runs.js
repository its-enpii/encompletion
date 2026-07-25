/**
 * Runs router — replaces the per-socket 'prompt'/'stop' handlers.
 *
 * Three endpoints, all under requireAuth:
 *   POST /sessions/:id/runs              → start a run, return runId
 *   GET  /sessions/:id/runs/:runId/stream → SSE stream of events
 *   POST /sessions/:id/runs/:runId/stop  → kill active runner
 *
 * The prompt-builder logic (project context, knowledge inlining,
 * transcript injection) is the bulk of the original socket handler —
 * extracted into buildFinalPrompt() so the route stays scannable.
 * Behavior is byte-for-byte identical to the previous server.js path.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { runLLM } from '../llm-runner.js';
import { detectArtifacts, evaluateArtifact } from '../artifact-detector.js';
import { renderProjectMemoryFactsBlock } from '../project_memory.js';
import rag from '../rag.js';
import registry from '../run-registry.js';

const router = express.Router();
router.use(requireAuth);

const MAX_KNOWLEDGE_BYTES = 512 * 1024;

/**
 * Build the final prompt string from session context, project knowledge,
 * conversation history, and the current user input. Mirrors the original
 * server.js socket handler block at lines 210-320 — kept as a single
 * function so the route body stays focused on lifecycle.
 */
function buildFinalPrompt({ dbSession, prompt, userMsgId, attachments }) {
  let prefix = '';

  // Inline text attachments directly into the prompt. Image attachments
  // are deliberately excluded here — they're sent to the model as
  // multimodal image_url parts (see imageParts in the handler) which is
  // what the LLM gateway expects. Without this filter, an image was
  // being uploaded twice: once as base64 text in the prompt prefix and
  // once as a vision image_url — easily 4-6MB of redundant payload for
  // three photos, enough to trip 9Router's 504 timeout on a slow link.
  // For non-image attachments (PDF, MD, CSV, etc.) we keep the inline
  // text path because the gateway doesn't accept those as multimodal.
  const inlineAtts = attachments.filter(
    (a) => a.content && (!a.mime_type || !a.mime_type.startsWith('image/'))
  );
  if (inlineAtts.length) {
    prefix +=
      '[Attachments]\n' +
      inlineAtts
        .map((a) => `--- ${a.file_name} (${a.mime_type}, ${a.size} bytes) ---\n${a.content}`)
        .join('\n\n') +
      '\n\n';
  }

  // Non-text attachments: just list paths so the model can Read them.
  const fileAtts = attachments.filter((a) => !a.content);
  if (fileAtts.length) {
    prefix +=
      '[Attached files (use Read tool on these paths)]\n' +
      fileAtts.map((a) => `- ${a.file_name} (${a.mime_type}, ${a.size} bytes) — stored at backend storage path: ${a.file_path}`).join('\n') +
      '\n\n';
  }

  // Project context: knowledge files (bounded). Project instructions
  // moved out of the user-prompt prefix and into the system prompt
  // via opts.projectInstructionsBlock — see routes/runs.js handler.
  if (dbSession.project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(dbSession.project_id);
    if (project) {
      const parts = [];
      const knowledge = db
        .prepare('SELECT title, type, content, file_path, file_name, mime_type, size FROM project_knowledge WHERE project_id = ?')
        .all(dbSession.project_id);
      if (knowledge.length) {
        let knowledgeBytes = 0;
        parts.push(
          '[Project Knowledge]\n' +
            knowledge.map((k) => {
              if (k.type === 'text') {
                const body = k.content || '';
                knowledgeBytes += Buffer.byteLength(body, 'utf8');
                return `--- ${k.title} ---\n${body}`;
              }
              // file-type knowledge: read from disk via storage path
              const rel = k.file_path || '';
              const abs = rel.startsWith('/')
                ? rel
                : (process.env.STORAGE_PATH
                    ? path.resolve(process.env.STORAGE_PATH, rel)
                    : rel);
              let body = '';
              try { body = fs.readFileSync(abs, 'utf8'); }
              catch (e) { body = `[unable to read file: ${e.message}]`; }
              if (Buffer.byteLength(body, 'utf8') + knowledgeBytes > MAX_KNOWLEDGE_BYTES) {
                body = body.slice(0, Math.max(0, MAX_KNOWLEDGE_BYTES - knowledgeBytes))
                  + `\n\n[truncated, total knowledge budget exceeded]`;
              }
              knowledgeBytes += Buffer.byteLength(body, 'utf8');
              return `--- ${k.title} (file: ${k.file_name || 'attached'}, ${k.mime_type || 'application/octet-stream'}, ${k.size || '?'} bytes) ---\n${body}`;
            }).join('\n\n')
        );
      }
      if (parts.length) prefix += parts.join('\n\n') + '\n\n';
    }
  }
  if (dbSession.system_prompt) prefix += dbSession.system_prompt + '\n\n';

  // Conversation history is built separately via buildHistoryMessages()
  // and passed through opts.history so each prior turn can carry its own
  // multimodal content (text + image_url parts). This prompt prefix only
  // carries project context + text-attachment inlines.

  return prefix
    ? `<system>\n${prefix.trim()}\n</system>\n\n${prompt}`
    : prompt;
}

/**
 * Same as buildFinalPrompt but with RAG augmentation: top-K semantic
 * hits from project_knowledge (project owner scope) and this session's
 * own attachment chunks (ephemeral) are appended under a [Relevant
 * Context] block. The caller must `await` this — embedding the query
 * is async.
 */
async function buildFinalPromptWithRag({ dbSession, prompt, userMsgId, attachments, reqUserId }) {
  const base = buildFinalPrompt({ dbSession, prompt, userMsgId, attachments });
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) return base;
  let hits = [];
  try {
    hits = await rag.query(prompt, {
      scopeUserId: reqUserId,
      sessionId: dbSession.id,
    });
  } catch (e) {
    process.stderr.write(`[runs] rag query failed: ${e.message}\n`);
    return base;
  }
  if (!hits || hits.length === 0) return base;
  process.stderr.write(
    `[runs] rag hits=${hits.length} top=${hits[0].label} score=${hits[0].score.toFixed(3)}\n`
  );
  const block = hits
    .map((h) => `--- ${h.label} ---\n${h.content}`)
    .join('\n\n');
  const augmented = `${base}\n\n[Relevant Context]\n${block}`;
  return augmented;
}

/**
 * Build the multimodal messages array for prior conversation turns.
 * Each entry's `content` is either a plain string (text-only turn) or an
 * array of content parts (text + image_url). The last `max` turns are
 * returned; older turns are dropped to bound the context window. Image
 * parts are reconstructed by reading the stored file from disk and
 * inlining as a base64 dataUrl — same shape the LLM gateway expects.
 */
function buildHistoryMessages(sessionId, currentUserMsgId, max) {
  if (!sessionId) return [];
  const rows = db
    .prepare(
      `SELECT id, role, content FROM messages
         WHERE session_id = ? AND id < ?
           AND role IN ('user','assistant')
         ORDER BY id DESC LIMIT ?`
    )
    .all(sessionId, currentUserMsgId, max);
  rows.reverse();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const atts = ids.length
    ? db
        .prepare(
          `SELECT message_id, file_name, file_path, mime_type
             FROM message_attachments
             WHERE message_id IN (${ids.map(() => '?').join(',')})
             ORDER BY message_id ASC, id ASC`
        )
        .all(...ids)
    : [];
  const attsByMsg = new Map();
  for (const a of atts) {
    if (!attsByMsg.has(a.message_id)) attsByMsg.set(a.message_id, []);
    attsByMsg.get(a.message_id).push(a);
  }
  return rows.map((m) => {
    const text = m.content || '';
    const atts = attsByMsg.get(m.id) || [];
    if (atts.length === 0) {
      if (!text) return null;
      return { role: m.role, content: text };
    }
    const imageAtts = atts.filter((a) => a.mime_type && a.mime_type.startsWith('image/'));
    const otherAtts = atts.filter((a) => !a.mime_type || !a.mime_type.startsWith('image/'));
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    if (m.role === 'user') {
      for (const a of imageAtts) {
        const dataUrl = readAttachmentAsDataUrl(a);
        if (dataUrl) parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        else parts.push({ type: 'text', text: `[image: ${a.file_name}]` });
      }
      if (otherAtts.length) {
        const note = '[attachments: ' +
          otherAtts.map((a) => `${a.file_name} (${a.mime_type || '?'})`).join(', ') +
          ']';
        parts.push({ type: 'text', text: note });
      }
    } else {
      const note = atts.map((a) => a.file_name).join(', ');
      parts.push({ type: 'text', text: `${text}${text ? '\n' : ''}[referenced: ${note}]` });
    }
    return { role: m.role, content: parts };
  }).filter(Boolean);
}

/**
 * Read an attachment row from disk and inline it as a dataUrl. Returns
 * null if the file is missing or the path looks like a placeholder.
 */
function readAttachmentAsDataUrl(att) {
  if (!att.file_path) return null;
  if (att.file_path.startsWith('paste:') || att.file_path.startsWith('camera:')) {
    return null;
  }
  try {
    const rel = att.file_path;
    const abs = rel.startsWith('/')
      ? rel
      : (process.env.STORAGE_PATH
          ? path.resolve(process.env.STORAGE_PATH, rel)
          : path.resolve('storage/attachments', rel));
    const buf = fs.readFileSync(abs);
    return `data:${att.mime_type || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// Greetings and one-word test pings that should never become a session
// title. Matching is case-insensitive and tolerates trailing punctuation
// + spaces. Common Indonesian + English fillers.
const GENERIC_PROMPT_RE = /^(halo|hai|hi|hello|hey|test|tes|ok|oke|okay|ya|yes|yoi|bro|broh|p|ping|\?+|!+|\.+|\s*)+$/i;
function isGenericPrompt(prompt) {
  if (!prompt) return true;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length < 4) return true;
  return GENERIC_PROMPT_RE.test(trimmed);
}

// Pull a short, useful title from the assistant's first reply. Strips
// fenced code blocks and markdown headings, then takes the first sentence
// or two-line segment, capped at 60 chars on a word boundary.
function deriveTitle(replyText) {
  if (!replyText || typeof replyText !== 'string') return null;
  const stripped = replyText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length < 4) return null;
  // First sentence (split on . ! ? followed by space + uppercase, or newline).
  const sentenceMatch = stripped.match(/^.{1,60}?[.!?](?:\s|$)/);
  let candidate = sentenceMatch ? sentenceMatch[0].trim() : stripped.slice(0, 60);
  // A short first sentence ("Bisa.", "OK.", "Sure.") is technically the
  // reply's first beat but useless as a sidebar title. When the captured
  // candidate is too short, drop the trailing punctuation and append the
  // next phrase so the title describes what the assistant actually said.
  const MIN_LEN = 20;
  if (candidate.length < MIN_LEN && stripped.length > candidate.length) {
    const tail = stripped.slice(candidate.length).replace(/^[.!?\s]+/, '');
    const filler = tail.slice(0, MIN_LEN - candidate.length + 10).trim();
    if (filler) {
      candidate = (candidate.replace(/[.!?]+$/, '') + ' ' + filler)
        .slice(0, 60)
        .trim();
    }
  }
  if (candidate.length > 60) {
    candidate = candidate.slice(0, candidate.lastIndexOf(' ', 57)) + '…';
  }
  if (candidate.length < 4) return null;
  return candidate;
}

/**
 * Start a run. Validates ownership, persists user message + attachments,
 * builds the prompt, calls the runner, and wires its onEvent callback to
 * the registry fan-out. Returns 202 + { runId, sessionId } immediately;
 * the actual streaming happens over the SSE endpoint.
 */
router.post('/sessions/:id/runs', async (req, res) => {
  const sessionId = Number(req.params.id);
  const {
    prompt, model, projectId, systemPrompt, attachments = [],
    effort,
    regenerate = false,
  } = req.body || {};

  // Empty prompt is fine if attachments are present — the model gets the
  // attachment prefix as the only context. A totally empty body (no prompt,
  // no attachments) is still a no-op worth rejecting.
  if (typeof prompt !== 'string' && !Array.isArray(attachments)) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (typeof prompt !== 'string' && (!Array.isArray(attachments) || attachments.length === 0)) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  const safePrompt = (typeof prompt === 'string' ? prompt : '').trim();
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid session id' });
  }

  // Project ownership check.
  if (projectId) {
    const own = db
      .prepare(
        `SELECT id FROM projects
          WHERE id = ? AND archived_at IS NULL
            AND (owner_type = 'user' AND owner_id = ? OR ? = 'admin')`
      )
      .get(projectId, String(req.user.id), req.user.role);
    if (!own) return res.status(403).json({ error: 'project not accessible' });
  }

  // Resolve or create session row.
  let dbSession;
  if (sessionId) {
    dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!dbSession) return res.status(404).json({ error: 'session not found' });
    if (req.user.role !== 'admin' && dbSession.user_id !== req.user.id) {
      return res.status(403).json({ error: 'session not accessible' });
    }
  } else {
    const info = db
      .prepare(
        `INSERT INTO sessions (title, model, project_id, system_prompt, user_id, owner_type, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`
      )
      .run(
        // Use a generic placeholder for new sessions — the real title is
        // computed in the run close handler from the assistant's first
        // reply (see dbSession.title assignment above). Inserting the
        // raw prompt here would lock in greetings like "Halo kamu" via
        // COALESCE in the post-run UPDATE.
        'New chat',
        model || process.env.DEFAULT_MODEL || 'workspace',
        projectId || null,
        systemPrompt || null,
        req.user.id,
        String(req.user.id),
        new Date().toISOString(),
        new Date().toISOString()
      );
    dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  }

  // Persist user message. For regenerations reuse the existing row.
  let userMsgId;
  if (regenerate) {
    const lastUser = db
      .prepare(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user'
           ORDER BY id DESC LIMIT 1`
      )
      .get(dbSession.id);
    if (!lastUser) return res.status(400).json({ error: 'no user message to regenerate from' });
    userMsgId = lastUser.id;
  } else {
    // Persist whichever prompt the user typed (may be empty), not the
    // generated fallback — the fallback is only used in the model
    // request body, not the user message row, so the chat history
    // stays faithful to what the user actually sent.
    const userMsg = db
      .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
      .run(dbSession.id, 'user', safePrompt);
    userMsgId = userMsg.lastInsertRowid;
  }

  for (const att of attachments) {
    const info = db.prepare(
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
    // Index for RAG — only if we have actual text to embed. The
    // sessionId binding makes these chunks ephemeral: when the session
    // is deleted, rag.removeSession() drops them.
    if (typeof att.content === 'string' && att.content.trim().length > 0) {
      rag
        .indexSource({
          kind: 'attachment',
          id: info.lastInsertRowid,
          content: att.content,
          sessionId: dbSession.id,
        })
        .catch((e) => process.stderr.write(`[runs] rag index failed: ${e.message}\n`));
    }
  }
  // Note: the original socket handler emitted 'attachments_saved' here for
  // composer UX, but the FE subscriber is a no-op (see Chat/index.tsx —
  // composer reads attachments from local state). Drop the emit; saves a
  // race against subscriber attach.

  const finalPrompt = await buildFinalPromptWithRag({
    dbSession, prompt: safePrompt, userMsgId, attachments, reqUserId: req.user.id,
  });

  // Build per-turn multimodal history so the model can re-see images from
  // earlier user turns. We cap at MAX_HISTORY messages; older turns get a
  // text-only placeholder referencing the attachment filenames so the
  // context window stays bounded.
  const MAX_HISTORY = 10;
  const historyMessages = buildHistoryMessages(dbSession.id, userMsgId, MAX_HISTORY);

  // Vision support: turn the *current turn's* attachments into image_url
  // parts. Three input shapes are accepted:
  //   1. dataUrl (composer fallback when /api/attachments upload failed)
  //   2. stored file_path on disk — read & base64 inline
  //   3. project knowledge file_path — same as #2 but resolved under
  //      STORAGE_PATH
  // Anything we can't render becomes a [Referenced image: name] marker in
  // the prompt so the model still knows a file existed.
  const imageParts = [];
  const imageNoteLines = [];
  for (const att of attachments) {
    if (!att.mime_type || !att.mime_type.startsWith('image/')) continue;
    let dataUrl = null;
    if (typeof att.content === 'string' && att.content.startsWith('data:')) {
      dataUrl = att.content;
    } else if (att.file_path && !att.file_path.startsWith('paste:') && !att.file_path.startsWith('camera:')) {
      try {
        const rel = att.file_path;
        const abs = rel.startsWith('/')
          ? rel
          : (process.env.STORAGE_PATH
              ? path.resolve(process.env.STORAGE_PATH, rel)
              : path.resolve('storage/attachments', rel));
        const buf = fs.readFileSync(abs);
        dataUrl = `data:${att.mime_type};base64,${buf.toString('base64')}`;
      } catch (e) {
        imageNoteLines.push(`- ${att.file_name} (could not read: ${e.message})`);
        continue;
      }
    } else {
      imageNoteLines.push(`- ${att.file_name} (binary only, no inline preview)`);
      continue;
    }
    imageParts.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  // Per-project skill opt-outs. JSON in SQLite is text; validate against
  // safeName rules in skill_loader to keep disabled names from reaching
  // the runner entirely.
  let disabledSkills = [];
  if (dbSession.project_id) {
    const proj = db.prepare('SELECT disabled_skills FROM projects WHERE id = ?').get(dbSession.project_id);
    if (proj?.disabled_skills) {
      try {
        const arr = JSON.parse(proj.disabled_skills);
        if (Array.isArray(arr)) disabledSkills = arr.filter((n) => typeof n === 'string').slice(0, 256);
      } catch { /* corrupt JSON — leave empty so the chat still works */ }
    }
  }

  // Per-project memory facts (Phase 5). Resolved here (not in the
  // runner) so the runner stays DB-free at chat time and the block
  // composition is consistent across routes/runs.js and routes/v1.js.
  // Empty string when project_id is null OR project has no facts;
  // the reducer in llm-runner filters it out cleanly.
  const projectMemoryBlock = dbSession.project_id
    ? renderProjectMemoryFactsBlock(dbSession.project_id)
    : '';

  // Project instructions (free-form prose) injected as a <system>
  // block instead of the user-prompt prefix. Read with a tiny SELECT
  // here so the runner doesn't need a DB handle. Empty string when
  // no project or no instructions; reducer filters it out cleanly.
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

  // Engine selection: llm is the OpenAI-compatible runner (default);
  // claude is the legacy subprocess fallback. The model key stored on
  // the session is passed verbatim.
  const ENGINE = (process.env.LLM_ENGINE || 'llm').toLowerCase();
  const runner = ENGINE === 'claude'
    ? (await import('../claude-runner.js')).runClaude
    : (await import('../llm-runner.js')).runLLM;

  const runId = registry.create({ sessionId: dbSession.id, userId: req.user.id });

  // Per-run accumulators — closure-scoped, not per-connection. The
  // runner onEvent fires once per event; registry fans it out to N SSE
  // subscribers (multi-tab).
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
  // Resolve cwd for tool execution. Falls back to the backend's process
  // cwd if the session doesn't have a workdir set — preserves the
  // pre-workdir behavior for existing sessions.
  let runCwd = process.cwd();
  if (dbSession.workdir) {
    try {
      fs.mkdirSync(dbSession.workdir, { recursive: true });
      runCwd = dbSession.workdir;
    } catch (e) {
      process.stderr.write(`[runs] failed to use workdir ${dbSession.workdir}: ${e.message}\n`);
    }
  }
  const ctrl = runner(
    finalPrompt,
    {
      model: dbSession.model,
      userId: req.user.id,
      effort: effort || process.env.DEFAULT_EFFORT || undefined,
      projectId: dbSession.project_id ?? undefined,
      projectMemoryBlock,
      projectInstructionsBlock,
      disabledSkills,
      images: imageParts,
      // Disable the tool registry when the user sends only attachments
      // with no text. With tools available the LLM often picks Bash/Read
      // first (workdir is empty, so it asks "Empty directory. What
      // building?") instead of just looking at the image it was handed.
      // Vision still works through the multimodal `image_url` parts;
      // we're just removing the alternative answer path.
      toolsEnabled: !!(safePrompt || !imageParts || imageParts.length === 0),
      history: historyMessages,
      cwd: runCwd,
    },
    (evt) => {
      // Compact one-line summary at boundaries; text deltas captured
      // separately when we suspect FE drop.
      if (evt.type === 'text') {
        if (typeof evt.text === 'string' && evt.text.length > 0) {
          assistantFullText += evt.text;
          registry.emit(runId, 'text', { sessionId: dbSession.id, text: evt.text });
        }
      } else if (
        evt.type === 'system' || evt.type === 'result' ||
        evt.type === 'stderr' || evt.type === 'tool_use' ||
        evt.type === 'tool_result' || evt.type === 'error'
      ) {
        process.stderr.write(
          `[runner ${dbSession.id}] ${evt.type}${evt.subtype ? '/' + evt.subtype : ''} ${evt.errorMessage || evt.message || evt.text || ''}`.trim() + '\n'
        );
      }
      if (evt.type === 'system' && evt.subtype === 'init') {
        cliSessionId = evt.session_id;
        registry.emit(runId, 'system', {
          sessionId: dbSession.id,
          claudeSessionId: cliSessionId,
          model: evt.model,
        });
      } else if (evt.type === 'assistant') {
        const blocks = evt.message?.content || [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            assistantFullText += block.text;
            registry.emit(runId, 'text', { sessionId: dbSession.id, text: block.text });
          } else if (block.type === 'tool_use') {
            toolStartedAt.set(block.id, Date.now());
            pendingToolUses.set(block.id, { toolName: block.name, input: block.input });
            registry.emit(runId, 'tool_use', {
              sessionId: dbSession.id,
              tool_use_id: block.id,
              tool_name: block.name,
              input: block.input,
            });
          }
        }
      } else if (evt.type === 'user') {
        const blocks = evt.message?.content || [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const id = block.tool_use_id;
            const pending = pendingToolUses.get(id);
            let output = block.content;
            if (typeof output !== 'string') output = JSON.stringify(output);
            const startedAtTool = toolStartedAt.get(id);
            toolRecords.push({
              tool_use_id: id,
              tool_name: pending?.toolName || 'unknown',
              input: JSON.stringify(pending?.input ?? null),
              output,
              is_error: block.is_error ? 1 : 0,
              duration_ms: startedAtTool ? Date.now() - startedAtTool : null,
            });
            pendingToolUses.delete(id);
            toolStartedAt.delete(id);
            registry.emit(runId, 'tool_result', {
              sessionId: dbSession.id,
              tool_use_id: id,
              content: block.content,
              is_error: !!block.is_error,
            });
          }
        }
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
        // Buffer for flush in close handler — artifacts.message_id NOT NULL
        // so we can't INSERT before the assistant row exists.
        pendingToolArtifacts.push(evt.artifact || {});
      }
    }
  );

  registry.attachRunner(runId, ctrl.proc, ctrl);

  ctrl.proc.on('close', (code) => {
    // Premature exit: no result event + non-zero code = engine died.
    if (!usage && code !== 0) {
      isError = true;
      registry.emit(runId, 'result', {
        isError: true,
        cost: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionId: dbSession.id,
        claudeSessionId: cliSessionId,
        exitCode: code,
        partialText: assistantFullText,
      });
    }

    // Persist assistant message — even if empty so the row exists for resume.
    const ai = db
      .prepare(
        `INSERT INTO messages
          (session_id, role, content, cost_usd, input_tokens, output_tokens, duration_ms)
         VALUES (?, 'assistant', ?, ?, ?, ?, ?)`
      )
      .run(
        dbSession.id,
        assistantFullText,
        costUsd,
        usage?.input_tokens || 0,
        usage?.output_tokens || 0,
        durationMs
      );
    activeMsgId = ai.lastInsertRowid;
    registry.emit(runId, 'message_saved', { messageId: activeMsgId });

    // Flush tool-emitted artifacts that arrived before the assistant row.
    if (pendingToolArtifacts.length) {
      const findDupStmtTool = db.prepare(
        `SELECT id FROM artifacts
           WHERE session_id = ? AND content_hash = ?
           ORDER BY id ASC LIMIT 1`
      );
      for (const art of pendingToolArtifacts) {
        if (!art.content) continue;
        const existing = art.content_hash
          ? findDupStmtTool.get(dbSession.id, art.content_hash)
          : null;
        if (existing) {
          db.prepare(
            `INSERT INTO artifacts
               (session_id, message_id, type, language, title, content,
                version, content_hash, dup_of)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
          ).run(
            dbSession.id, activeMsgId,
            art.type || 'code', art.language || null,
            art.title || 'Artifact', art.content,
            art.content_hash || null, existing.id
          );
          registry.emit(runId, 'artifact_dup', {
            duplicate_of: existing.id, title: art.title, type: art.type, message_id: activeMsgId,
          });
          continue;
        }
        const insert = db.prepare(
          `INSERT INTO artifacts
             (session_id, message_id, type, language, title, content,
              version, content_hash, dup_of)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`
        ).run(
          dbSession.id, activeMsgId,
          art.type || 'code', art.language || null,
          art.title || 'Artifact', art.content,
          art.content_hash || null
        );
        registry.emit(runId, 'artifact', {
          id: insert.lastInsertRowid,
          session_id: dbSession.id,
          message_id: activeMsgId,
          type: art.type || 'code',
          language: art.language || null,
          title: art.title || 'Artifact',
          content: art.content,
          content_preview: (art.content || '').slice(0, 220),
          line_count: (art.content || '').split('\n').length,
          content_hash: art.content_hash || null,
          version: 1,
          source: 'tool',
        });
      }
      pendingToolArtifacts.length = 0;
    }

    // Persist tool_uses.
    for (const rec of toolRecords) {
      db.prepare(
        `INSERT INTO tool_uses
           (message_id, tool_use_id, tool_name, input, output, is_error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(activeMsgId, rec.tool_use_id, rec.tool_name, rec.input, rec.output, rec.is_error, rec.duration_ms);
    }

    // Fence-detected artifacts from the full assistant text. Capped at
    // MAX_PER_MESSAGE to avoid panel explosion on long refactors.
    const MAX_PER_MESSAGE = 8;
    const detected = detectArtifacts(assistantFullText).slice(0, MAX_PER_MESSAGE);
    const allFences = evaluateArtifact(assistantFullText);
    const rejectionCounts = {};
    for (const f of allFences) {
      if (!f.verdict.keep) rejectionCounts[f.verdict.reason] = (rejectionCounts[f.verdict.reason] || 0) + 1;
    }
    const rejectedTotal = Object.values(rejectionCounts).reduce((a, b) => a + b, 0);

    const findDupStmt = db.prepare(
      `SELECT id FROM artifacts
         WHERE session_id = ? AND content_hash = ?
         ORDER BY id ASC LIMIT 1`
    );
    for (const art of detected) {
      const existing = art.content_hash
        ? findDupStmt.get(dbSession.id, art.content_hash)
        : null;
      if (existing) {
        db.prepare(
          `INSERT INTO artifacts
             (session_id, message_id, type, language, title, content,
              version, content_hash, dup_of)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
          dbSession.id, activeMsgId,
          art.type, art.language, art.title, art.content,
          art.content_hash, existing.id
        );
        registry.emit(runId, 'artifact_dup', {
          duplicate_of: existing.id, title: art.title, type: art.type, message_id: activeMsgId,
        });
        continue;
      }
      const insert = db
        .prepare(
          `INSERT INTO artifacts
             (session_id, message_id, type, language, title, content,
              version, content_hash, dup_of)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)`
        )
        .run(
          dbSession.id, activeMsgId,
          art.type, art.language, art.title, art.content, art.content_hash
        );
      registry.emit(runId, 'artifact', {
        id: insert.lastInsertRowid,
        session_id: dbSession.id,
        message_id: activeMsgId,
        ...art,
        version: 1,
      });
    }

    if (rejectedTotal > 0) {
      const breakdown = Object.entries(rejectionCounts)
        .map(([reason, n]) => `${n} ${reason}`).join(', ');
      registry.emit(runId, 'artifact_rejections', { kept: detected.length, rejected: rejectedTotal, breakdown });
    }

    // Session aggregate + auto-title.
    // The literal prompt is usually a poor title ("Halo", "tes", "ok").
    // Prefer, in order:
    //   1. assistant's first reply, truncated — gives the actual topic
    //   2. attachment filename, when the prompt was empty / image-only
    //   3. a trimmed prompt that's at least 3 words and not a greeting
    //   4. null (sidebar shows "Session #<id>" placeholder)
    //
    // When to run: only on the FIRST user turn of a session. After that
    // the user may have renamed it manually via the sidebar — we never
    // overwrite that. Detection: count of persisted user messages. If
    // it's exactly 1 (the one we just inserted), this is the first
    // turn. (The check uses `db` directly because the in-memory
    // dbSession object doesn't reflect the INSERT that ran just above.)
    //
    // Why this matters: the FE pre-fills the title with the prompt on
    // /api/sessions POST so the new session is identifiable in the
    // sidebar immediately. The old `!dbSession.title` guard skipped
    // auto-title for those sessions — leaving them stuck at the literal
    // prompt forever. Count-based detection restores the intent.
    const userMsgCount = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
      .get(dbSession.id).n;
    const isFirstUserTurn = userMsgCount === 1;
    if (isFirstUserTurn && !isError) {
      // Skip auto-derive when the run errored on the first turn — the
      // FE is about to delete the whole session (see cleanup below),
      // so deriving a title here is wasted work.
      const replyTitle = deriveTitle(assistantFullText);
      // Image-only send (no prompt text) — surface a generic label
      // instead of the raw filename. The filename is technical metadata
      // ("IMG_20260115_103847.png") and is rarely a good sidebar title.
      // Once the assistant replies, the next turn's title logic kicks
      // in via replyTitle; the placeholder here just keeps the sidebar
      // human-readable while we wait.
      const hasImages = Array.isArray(attachments) && attachments.length > 0;
      const imageOnly = hasImages && !safePrompt.trim();
      const attTitle = imageOnly
        ? attachments.length === 1
          ? "Image"
          : `${attachments.length} images`
        : attachments[0]?.file_name
          ? attachments[0].file_name.replace(/\.[^.]+$/, '')
          : null;
      const promptTitle = isGenericPrompt(safePrompt)
        ? null
        : safePrompt.split(/\s+/).slice(0, 8).join(' ');
      dbSession.title = replyTitle || attTitle || promptTitle || null;
    }

    // Cleanup on error. The user asked: instead of leaving an empty
    // assistant row + a stale user prompt that produces nothing useful,
    // nuke the failed turn. Different scopes:
    //   - First turn error: delete the whole session (it has nothing
    //     useful — no earlier assistant, no prior user turns).
    //   - Later turn error: drop just the user + assistant pair so the
    //     earlier context survives.
    // rag.removeSession() also drops any indexed chunks attached to
    // this turn's attachments so the next session isn't polluted.
    let cleanupSessionDeleted = false;
    let cleanupTurnDeleted = false;
    if (isError) {
      try {
        rag.removeSession(dbSession.id);
      } catch { /* rag is best-effort */ }
      if (isFirstUserTurn) {
        try {
          // Wipe the assistant row we just inserted, plus tool_uses
          // and the user message (cascade kills message_attachments),
          // then drop the session row itself.
          db.prepare('DELETE FROM messages WHERE id IN (?, ?)').run(activeMsgId, userMsgId);
          db.prepare('DELETE FROM tool_uses WHERE message_id IN (?, ?)').run(activeMsgId, userMsgId);
          db.prepare('DELETE FROM artifacts WHERE message_id IN (?, ?)').run(activeMsgId, userMsgId);
          db.prepare('DELETE FROM sessions WHERE id = ?').run(dbSession.id);
          cleanupSessionDeleted = true;
          dbSession = null;
        } catch (e) {
          process.stderr.write(`[runs] cleanup (delete session ${dbSession?.id}) failed: ${e.message}\n`);
        }
      } else {
        try {
          db.prepare('DELETE FROM messages WHERE id IN (?, ?)').run(activeMsgId, userMsgId);
          db.prepare('DELETE FROM tool_uses WHERE message_id IN (?, ?)').run(activeMsgId, userMsgId);
          db.prepare('DELETE FROM artifacts WHERE message_id IN (?, ?)').run(activeMsgId, userMsgId);
          cleanupTurnDeleted = true;
        } catch (e) {
          process.stderr.write(`[runs] cleanup (delete turn in session ${dbSession?.id}) failed: ${e.message}\n`);
        }
      }
    }
    // Title handling has two paths:
    //   - First user turn (isFirstUserTurn): we always overwrite with
    //     the auto-derived title, even when the FE pre-filled with the
    //     prompt text. The old `COALESCE(NULLIF(title, 'New chat'), ?)`
    //     guard skipped the overwrite for any pre-set title, which is
    //     why sessions got stuck at the literal prompt forever.
    //   - Subsequent turns: never overwrite (the user may have renamed
    //     via the sidebar).
    // When the cleanup path deleted the session, dbSession is null —
    // skip the aggregate UPDATE entirely.
    if (dbSession) {
      db.prepare(
        `UPDATE sessions
           SET claude_session_id = COALESCE(?, claude_session_id),
               title             = CASE WHEN ? = 1 THEN ?
                                       ELSE COALESCE(NULLIF(title, 'New chat'), ?)
                                  END,
               total_cost_usd   = total_cost_usd + ?,
               total_tokens     = total_tokens + ?,
               updated_at       = ?
         WHERE id = ?`
      ).run(
        cliSessionId,
        isFirstUserTurn ? 1 : 0,
        dbSession.title,
        dbSession.title,
        costUsd,
        (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        new Date().toISOString(),
        dbSession.id
      );
    }

    registry.emit(runId, 'done', {
      sessionId: dbSession?.id ?? null,
      messageId: activeMsgId,
      isError,
      resumable: !!isError && !!cliSessionId,
      claudeSessionId: cliSessionId || null,
      exitCode: code,
      partialText: isError ? assistantFullText : null,
      // Surface the new title so the FE header and sidebar refresh
      // without a second round-trip to /full.
      title: dbSession?.title ?? null,
      // Tell the FE whether to navigate away / refresh. cleanup flags
      // drive the auto-cleanup policy: first-turn failure → drop the
      // session entirely; later-turn failure → nuke just the failed
      // pair. The FE wipes its local state accordingly so the user
      // doesn't see an empty assistant row sitting forever.
      cleanupSessionDeleted: cleanupSessionDeleted || undefined,
      cleanupTurnDeleted: cleanupTurnDeleted || undefined,
    });

    process.stderr.write(`[runner ${dbSession?.id ?? 'deleted'}] done in ${Date.now() - startedAt}ms (run ${runId})\n`);
    registry.end(runId);
  });

  res.status(202).json({ runId, sessionId: dbSession.id });
});

/**
 * SSE stream of events for an in-flight or recently-ended run.
 * The EventSource client must pass the JWT via ?token= (EventSource can't
 * send custom headers). requireAuth runs first; if the runId is unknown
 * we send 404 with a JSON body so the client can branch cleanly.
 */
router.get('/sessions/:id/runs/:runId/stream', (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid run id' });
  }
  const ok = registry.subscribe(runId, req, res);
  if (!ok) return; // subscribe already wrote the 404 response
});

/**
 * Kill an active runner. Ownership-checked: a member can only stop their
 * own runs; admins can stop any. Returns 200 even if the run already
 * ended (idempotent).
 */
router.post('/sessions/:id/runs/:runId/stop', (req, res) => {
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid run id' });
  }
  const ok = registry.stop(runId, req.user.id);
  if (!ok) {
    // Distinguish "not found" from "not yours" — admins always own, so
    // a 403 here means a member tried to stop someone else's run.
    return res.status(req.user.role === 'admin' ? 404 : 403).json({ ok: false });
  }
  res.json({ ok: true });
});

export default router;
