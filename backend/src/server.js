import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db/index.js';
import sessionsRouter from './routes/sessions.js';
import projectsRouter from './routes/projects.js';
import authRouter from './routes/auth.js';
import attachmentsRouter from './routes/attachments.js';
import usersRouter from './routes/users.js';
import rolesRouter from './routes/roles.js';
import skillsRouter from './routes/skills.js';
import modelsRouter from './routes/models.js';
import artifactsRouter from './routes/artifacts.js';
import runsRouter from './routes/runs.js';
import apiKeysRouter from './routes/api-keys.js';
import v1Router from './routes/v1.js';
import embedRouter from './routes/embed.js';
import embedAdminRouter from './routes/embed-admin.js';
import memoryRouter from './routes/memory.js';
import { startExtractorWorker } from './extractor-worker.js';
import { startIndexerWorker } from './indexer-worker.js';
import { startCompactorWorker } from './compactor-worker.js';
import { requireAuth } from './middleware/auth.js';
import { requireApiKey } from './middleware/api-key.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

// Bootstrap default user (only when DB is empty). After migrate() runs,
// the first user is promoted to 'admin' (see db/index.js).
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const u = process.env.BOOTSTRAP_USERNAME || 'admin';
  const p = process.env.BOOTSTRAP_PASSWORD || (NODE_ENV === 'production' ? null : 'admin12345');
  if (!p) throw new Error('BOOTSTRAP_PASSWORD must be set in production');
  // Refuse well-known defaults in production so a forgotten .env can't
  // ship with admin/admin12345.
  if (NODE_ENV === 'production' && (p === 'admin12345' || p === 'admin' || p.length < 12)) {
    throw new Error('BOOTSTRAP_PASSWORD too weak for production (min 12 chars, not a default)');
  }
  const hash = bcrypt.hashSync(p, 12);
  db.prepare(
    `INSERT INTO users (username, password, role, display_name)
     VALUES (?, ?, 'admin', 'Administrator')`
  ).run(u, hash);
  console.log(`[auth] bootstrapped admin user "${u}"`);
}

const app = express();
// CORS allowlist. Empty CORS_ORIGINS → no Access-Control-Allow-Origin
// (same-origin via nginx is fine). Comma-separated list for multi-host.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Non-browser (curl, server-to-server) — no Origin header.
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0) return cb(null, false);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: '30mb' }));

// Embed widget static — minimal client for tenant apps. Hosted at
// /embed/* so the embed.js script tag stays short.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/embed', express.static(path.resolve(__dirname, '../public'), { fallthrough: false }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'encompletion', time: new Date().toISOString() });
});

app.use('/api/auth', authRouter);

// Run lifecycle MUST mount before `/api/sessions` + requireAuth.
// Stream path is /api/sessions/:id/runs/:runId/stream?ticket=… — if
// sessions' requireAuth runs first, EventSource (no Bearer) gets 401 and
// never reaches requireAuthOrStreamTicket. Per-route auth lives on runsRouter.
app.use('/api', runsRouter);

app.use('/api/users', requireAuth, usersRouter);
app.use('/api/roles', requireAuth, rolesRouter);
app.use('/api/sessions', requireAuth, sessionsRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/attachments', requireAuth, attachmentsRouter);
// Skills live in the engine-neutral skills directory ($HOME/.enllm/skills/),
// so they're global per-user, not per-session. Any logged-in user can manage.
app.use('/api/skills', requireAuth, skillsRouter);
app.use('/api/models', requireAuth, modelsRouter);
app.use('/api/artifacts', requireAuth, artifactsRouter);
app.use('/api/api-keys', requireAuth, apiKeysRouter);

// Memory facts — per-user persistent context injected into every system
// prompt. requireAuth-scoped: a user only ever sees their own facts.
app.use('/api/memory', requireAuth, memoryRouter);

// Public OpenAPI surface — auth via api-keys, model locked to the key.
// MUST be mounted before `/api` catch-alls so v1 paths don't hit JWT.
app.use('/api/v1', requireApiKey, v1Router);

// Embed mode (E2) — browser widget API. Mixed auth:
//   POST /api/embed/token  → tenant_api_key (server-to-server)
//   everything else        → embed_token (issued by the route above)
// The router handles its own auth per-handler because the two surfaces
// can't share a single middleware.
app.use('/api/embed', embedRouter);

// Embed mode (E3.4) — admin CRUD for tenants, capability profiles,
// tools, and the tool_executions audit log. All routes require admin.
app.use('/api/admin/embed', embedAdminRouter);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  // Memory auto-extractor: idle-poll worker. Runs once on boot to catch
  // up on sessions that went quiet while the server was down, then on a
  // MEMORY_POLL_MS interval (default 60s). .unref()'d so it never keeps
  // the event loop alive on its own.
  startExtractorWorker();
  // Cross-session recall indexer: same idle-poll pattern, but writes
  // per-message embeddings instead of facts. Both workers can run in
  // parallel — they're on independent timers and touch different
  // tables.
  startIndexerWorker();
  // Conversation compactor: idle-poll worker that summarizes the
  // older portion of long transcripts. Writes session_summaries
  // (one row per session, PRIMARY KEY → rolling update in place).
  startCompactorWorker();
});
