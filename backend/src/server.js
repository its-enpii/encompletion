import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { Server as SocketIOServer } from 'socket.io';
import { runClaude } from './claude-runner.js';
import db from './db/index.js';
import sessionsRouter from './routes/sessions.js';
import projectsRouter from './routes/projects.js';
import authRouter from './routes/auth.js';
import attachmentsRouter from './routes/attachments.js';
import usersRouter from './routes/users.js';
import skillsRouter from './routes/skills.js';
import modelsRouter from './routes/models.js';
import { requireAuth, socketAuth } from './middleware/auth.js';
import { detectArtifacts, evaluateArtifact } from './artifact-detector.js';

const PORT = parseInt(process.env.PORT || '4000', 10);

// Bootstrap default user (only when DB is empty). After migrate() runs,
// the first user is promoted to 'admin' (see db/index.js).
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const u = process.env.BOOTSTRAP_USERNAME || 'admin';
  const p = process.env.BOOTSTRAP_PASSWORD || 'admin12345';
  const hash = bcrypt.hashSync(p, 10);
  db.prepare(
    `INSERT INTO users (username, password, role, display_name)
     VALUES (?, ?, 'admin', 'Administrator')`
  ).run(u, hash);
  console.log(`[auth] bootstrapped admin user "${u}"`);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'claude-web-backend', time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/sessions', requireAuth, sessionsRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/attachments', requireAuth, attachmentsRouter);
// Skills live in the Claude CLI's own filesystem path ($HOME/.claude/skills/),
// so they're global per-user, not per-session. Any logged-in user can manage.
app.use('/api/skills', requireAuth, skillsRouter);
app.use('/api/models', requireAuth, modelsRouter);

// ----- Socket.IO -----
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 30e6,
});

io.use(socketAuth);
// Expose io to route handlers via app.locals so mutations like the
// /api/models admin endpoints can broadcast `models:updated` to every
// connected socket (other tabs + other admins stay in sync).
app.set('io', io);

io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`[socket] connected ${socket.id} as ${user.username}`);

  let activeRunner = null;
  let activeSessionId = null;
  let activeMsgId = null;
  // Track tool_use_id -> { toolName, input } while we wait for tool_result blocks
  const pendingToolUses = new Map();
  // Accumulate the full assistant text for artifact detection on close
  let assistantFullText = '';
  // Tool records to save to DB at close
  const toolRecords = [];
  const toolStartedAt = new Map();
  // Heartbeat ticker — pings client every 30s while a prompt is streaming so
  // the frontend can detect hangs (nginx/browser idle timeouts, stalled CLI).
  let heartbeatTimer = null;
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      socket.emit('tick', { sessionId: activeSessionId, t: Date.now() });
    }, 30_000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  socket.on('prompt', async (payload, ack) => {
    const {
      prompt, model, sessionId, projectId, systemPrompt, attachments = [],
      effort,
      // When set, treat this as a regeneration: reuse the most recent user
      // message from the DB instead of inserting a new one. Used together with
      // `POST /api/sessions/:id/messages/:msgId/regenerate`, which deletes the
      // previous assistant reply beforehand.
      regenerate = false,
    } = payload || {};
    if (!prompt || typeof prompt !== 'string') {
      socket.emit('error', { message: 'prompt is required' });
      ack?.({ ok: false, error: 'prompt required' });
      return;
    }

    if (projectId) {
      const own = db
        .prepare(
          `SELECT id FROM projects
            WHERE id = ? AND archived_at IS NULL
              AND (user_id = ? OR ? = 'admin')`
        )
        .get(projectId, user.id, user.role);
      if (!own) {
        socket.emit('error', { message: `project ${projectId} not accessible` });
        ack?.({ ok: false, error: 'project not accessible' });
        return;
      }
    }

    let dbSession;
    if (sessionId) {
      dbSession = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(sessionId);
      if (!dbSession) {
        socket.emit('error', { message: `session ${sessionId} not found` });
        ack?.({ ok: false, error: 'session not found' });
        return;
      }
      // Ownership: members can only continue their own sessions
      if (user.role !== 'admin' && dbSession.user_id !== user.id) {
        socket.emit('error', { message: 'session not accessible' });
        ack?.({ ok: false, error: 'session not accessible' });
        return;
      }
    } else {
      const info = db
        .prepare(
          `INSERT INTO sessions (title, model, project_id, system_prompt, user_id)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          prompt.slice(0, 80),
          model || process.env.DEFAULT_MODEL || 'workspace',
          projectId || null,
          systemPrompt || null,
          user.id
        );
      dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
    }
    activeSessionId = dbSession.id;

    // Save user message + attachments
    // For regenerations, reuse the last user message id — the caller already
    // deleted the previous assistant reply via the regenerate REST endpoint,
    // so we must NOT insert a new user row (would shift the transcript).
    let userMsgId;
    if (regenerate) {
      const lastUser = db
        .prepare(
          `SELECT id FROM messages WHERE session_id = ? AND role = 'user'
             ORDER BY id DESC LIMIT 1`
        )
        .get(dbSession.id);
      if (!lastUser) {
        socket.emit('error', { message: 'no user message to regenerate from' });
        ack?.({ ok: false, error: 'no user message' });
        return;
      }
      userMsgId = lastUser.id;
    } else {
      const userMsg = db
        .prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)')
        .run(dbSession.id, 'user', prompt);
      userMsgId = userMsg.lastInsertRowid;
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
    // Notify client of saved attachments (for UI thumbnails)
    socket.emit('attachments_saved', { messageId: userMsgId, count: attachments.length });

    // Build the final prompt with system context + attachments
    let prefix = '';

    // Attachments (text-ish): prepend inline content
    const inlineAtts = attachments.filter((a) => a.content);
    if (inlineAtts.length) {
      prefix +=
        '[Attachments]\n' +
        inlineAtts
          .map((a) => `--- ${a.file_name} (${a.mime_type}, ${a.size} bytes) ---\n${a.content}`)
          .join('\n\n') +
        '\n\n';
    }
    // Non-text attachments: list paths so Claude can Read them
    const fileAtts = attachments.filter((a) => !a.content);
    if (fileAtts.length) {
      prefix +=
        '[Attached files (use Read tool on these paths)]\n' +
        fileAtts.map((a) => `- ${a.file_name} (${a.mime_type}, ${a.size} bytes) — stored at backend storage path: ${a.file_path}`).join('\n') +
        '\n\n';
    }

    // Project context
    if (dbSession.project_id) {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(dbSession.project_id);
      if (project) {
        const parts = [];
        if (project.instructions) parts.push(`[Project Instructions]\n${project.instructions}`);
        const knowledge = db
          .prepare('SELECT title, type, content, file_name FROM project_knowledge WHERE project_id = ?')
          .all(dbSession.project_id);
        if (knowledge.length) {
          parts.push(
            '[Project Knowledge]\n' +
              knowledge
                .map((k) => {
                  if (k.type === 'text') return `--- ${k.title} ---\n${k.content || ''}`;
                  return `--- ${k.title} (file: ${k.file_name || 'attached'}) ---`;
                })
                .join('\n\n')
          );
        }
        if (parts.length) prefix += parts.join('\n\n') + '\n\n';
      }
    }
    if (dbSession.system_prompt) prefix += dbSession.system_prompt + '\n\n';

    // Conversation history for resume. We previously relied on `--resume <claude_session_id>`
    // to ask Claude CLI to restore context from its own session files. That works locally
    // when ~/.claude/projects/<cwd>/<id>.jsonl exists, but in containerized runs the
    // directory is empty (no persistent volume mount of ~/.claude) — CLI exits with code 1
    // on every "continue" because the resume target is missing.
    //
    // Instead, we inject the prior messages from our own DB as a transcript. New prompt
    // is sent with the user message + the full prior turn-by-turn history. Claude gets
    // full context without needing its session file. The `claude_session_id` field is
    // still saved (so any future native CLI session lookup has a reference) but is not
    // passed via --resume anymore.
    if (dbSession.id) {
      const history = db
        .prepare(
          `SELECT role, content FROM messages
             WHERE session_id = ? AND id < ?
             ORDER BY id ASC`
        )
        .all(dbSession.id, userMsgId);
      if (history.length > 0) {
        const transcript = history
          .filter((m) => m.content)
          .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        if (transcript) {
          prefix += '[Conversation History]\n' + transcript + '\n\n';
        }
      }
    }

    const finalPrompt = prefix
      ? `<system>\n${prefix.trim()}\n</system>\n\n${prompt}`
      : prompt;

    // Reset per-prompt accumulators
    assistantFullText = '';
    pendingToolUses.clear();
    toolRecords.length = 0;
    toolStartedAt.clear();

    let cliSessionId = dbSession.claude_session_id || null;
    let usage = null;
    let costUsd = 0;
    let durationMs = 0;
    let isError = false;

    socket.emit('start', { sessionId: dbSession.id, messageId: null });
    startHeartbeat();

    // NOTE: We deliberately do NOT pass `--resume <claude_session_id>` here.
    // Conversation history is instead injected inline as a transcript (see above).
    activeRunner = runClaude(
      finalPrompt,
      {
        model: dbSession.model,
        effort: effort || process.env.DEFAULT_EFFORT || undefined,
      },
      (evt) => {
        if (evt.type === 'system' && evt.subtype === 'init') {
          cliSessionId = evt.session_id;
          socket.emit('system', {
            sessionId: dbSession.id,
            claudeSessionId: cliSessionId,
            model: evt.model,
          });
        } else if (evt.type === 'assistant') {
          const blocks = evt.message?.content || [];
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              assistantFullText += block.text;
              socket.emit('text', { text: block.text });
            } else if (block.type === 'tool_use') {
              toolStartedAt.set(block.id, Date.now());
              pendingToolUses.set(block.id, {
                toolName: block.name,
                input: block.input,
              });
              socket.emit('tool_use', {
                tool_use_id: block.id,
                tool_name: block.name,
                input: block.input,
              });
            }
          }
        } else if (evt.type === 'user') {
          // tool_result blocks come back as a user turn
          const blocks = evt.message?.content || [];
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              const id = block.tool_use_id;
              const pending = pendingToolUses.get(id);
              let output = block.content;
              if (typeof output !== 'string') {
                output = JSON.stringify(output);
              }
              const startedAt = toolStartedAt.get(id);
              toolRecords.push({
                tool_use_id: id,
                tool_name: pending?.toolName || 'unknown',
                input: JSON.stringify(pending?.input ?? null),
                output,
                is_error: block.is_error ? 1 : 0,
                duration_ms: startedAt ? Date.now() - startedAt : null,
              });
              pendingToolUses.delete(id);
              toolStartedAt.delete(id);
              socket.emit('tool_result', {
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
          socket.emit('result', {
            isError,
            cost: costUsd,
            durationMs,
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            sessionId: dbSession.id,
            claudeSessionId: cliSessionId,
          });
        } else if (evt.type === 'error') {
          socket.emit('error', { message: evt.message });
        } else if (evt.type === 'stderr') {
          socket.emit('stderr', { text: evt.text });
        }
      }
    );

    activeRunner.proc.on('close', (code) => {
      // Detect premature exit: if close fires but no 'result' event was seen,
      // CLI died before completing (network drop, Anthropic error, OOM, etc.).
      // Treat as error and surface for resume.
      if (!usage && code !== 0) {
        isError = true;
        socket.emit('result', {
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
      // Persist assistant message — even if empty (so the row exists for resume)
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
      socket.emit('message_saved', { messageId: activeMsgId });

      // Persist tool_uses linked to the assistant message
      for (const rec of toolRecords) {
        db.prepare(
          `INSERT INTO tool_uses
             (message_id, tool_use_id, tool_name, input, output, is_error, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          activeMsgId,
          rec.tool_use_id,
          rec.tool_name,
          rec.input,
          rec.output,
          rec.is_error,
          rec.duration_ms
        );
      }

      // Persist artifacts detected from full assistant text.
      // Noise-reduction pipeline:
      //   (1) detector: smart gate keeps only artifacts that look intentional
      //       (own-line, intent phrase, header-style title; code only with header).
      //   (2) here we dedup by content_hash within this session — Claude sometimes
      //       re-emits the same block (e.g. "here's the file again" after edits).
      //   (3) cap at MAX_PER_MESSAGE to avoid panel explosion on long refactors.
      const MAX_PER_MESSAGE = 8;
      const detected = detectArtifacts(assistantFullText).slice(0, MAX_PER_MESSAGE);

      // Audit: walk all fences, count rejections so frontend can surface a
      // summary when many blocks were dropped as non-artifacts.
      const allFences = evaluateArtifact(assistantFullText);
      const rejectionCounts = {};
      for (const f of allFences) {
        if (!f.verdict.keep) {
          rejectionCounts[f.verdict.reason] = (rejectionCounts[f.verdict.reason] || 0) + 1;
        }
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
          // Same content already in this session — link via dup_of, don't re-emit.
          db.prepare(
            `INSERT INTO artifacts
               (session_id, message_id, type, language, title, content,
                version, content_hash, dup_of)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
          ).run(
            dbSession.id,
            activeMsgId,
            art.type,
            art.language,
            art.title,
            art.content,
            art.content_hash,
            existing.id
          );
          socket.emit('artifact_dup', {
            duplicate_of: existing.id,
            title: art.title,
            type: art.type,
            message_id: activeMsgId,
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
            dbSession.id,
            activeMsgId,
            art.type,
            art.language,
            art.title,
            art.content,
            art.content_hash
          );
        socket.emit('artifact', {
          id: insert.lastInsertRowid,
          session_id: dbSession.id,
          message_id: activeMsgId,
          ...art,
          version: 1,
        });
      }

      // Surface rejection summary once per response (when something was dropped).
      if (rejectedTotal > 0) {
        const breakdown = Object.entries(rejectionCounts)
          .map(([reason, n]) => `${n} ${reason}`).join(', ');
        socket.emit('artifact_rejections', {
          kept: detected.length,
          rejected: rejectedTotal,
          breakdown,
        });
      }

      // Update session aggregate + auto-title
      const titleNeedsUpdate = !dbSession.title && prompt;
      if (titleNeedsUpdate) dbSession.title = prompt.slice(0, 80);
      db.prepare(
        `UPDATE sessions
           SET claude_session_id = COALESCE(?, claude_session_id),
               title             = COALESCE(title, ?),
               total_cost_usd   = total_cost_usd + ?,
               total_tokens     = total_tokens + ?,
               updated_at       = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(
        cliSessionId,
        dbSession.title,
        costUsd,
        (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
        dbSession.id
      );

      socket.emit('done', {
        sessionId: dbSession.id,
        messageId: activeMsgId,
        isError,
        // If the run errored but we have a Claude session ID, the user can
        // resume by re-sending a prompt — server will pass --resume.
        resumable: !!isError && !!cliSessionId,
        claudeSessionId: cliSessionId || null,
        exitCode: code,
        partialText: isError ? assistantFullText : null,
      });
      activeRunner = null;
      activeRunner = null;
      stopHeartbeat();
    });

    ack?.({ ok: true, sessionId: dbSession.id });
  });

  socket.on('stop', () => {
    if (activeRunner) {
      activeRunner.kill();
      activeRunner = null;
      socket.emit('stopped', { sessionId: activeSessionId });
    }
  });

  socket.on('disconnect', () => {
    if (activeRunner) activeRunner.kill();
    stopHeartbeat();
    console.log(`[socket] disconnected ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});