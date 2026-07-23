/**
 * Run registry — module-scoped fan-out for in-flight LLM runs.
 *
 * Why a Map keyed by runId (and not per-handler closure): one run can have
 * many SSE subscribers (multi-tab, late reconnects) and the runner loop
 * lives in runLLM, not in any HTTP handler. The registry decouples the
 * runner from the response stream so a tab refresh mid-stream doesn't kill
 * the LLM, and a second tab opened against the same runId sees identical
 * frames.
 *
 * SSE wire format written by emit():
 *   event: <name>
 *   data: <json>
 *   <blank line>
 *
 * Plus a ": keepalive\n\n" comment every 25s so intermediate proxies
 * (nginx default 60s, corporate proxies often 30s) don't kill the idle
 * connection mid-stream.
 *
 * Lifecycle:
 *   1. POST /sessions/:id/runs  → runs.create() returns runId
 *   2. Handler calls runLLM, then runs.attachRunner(runId, runner, ctrl)
 *   3. Client opens GET /sessions/:id/runs/:runId/stream → runs.subscribe()
 *   4. onEvent callback fires emit(runId, ...) from inside the handler
 *   5. proc.on('close') → runs.end(runId) — drains subscribers, drops row after 60s grace
 *
 * Grace period (60s) lets a late EventSource reconnect still read final
 * state; registry.end() writes ": end\n\n" before closing so the client
 * knows the stream terminated normally.
 */

const KEEPALIVE_MS = 25_000;
const GRACE_MS = 120_000;

class RunState {
  constructor({ runId, sessionId, userId }) {
    this.runId = runId;
    this.sessionId = sessionId;
    this.userId = userId;
    this.runner = null;             // EventEmitter from llm-runner.js
    this.controller = null;         // { kill } from runner
    this.subscribers = new Set();   // active SSE response streams
    this.keepalives = new Map();    // res -> interval handle
    this.ended = false;
    this.graceTimer = null;
  }
}

const runs = new Map();

function newRunId() {
  // Sufficient for in-process uniqueness: 1ms resolution + 1k jitter.
  // No DB persistence needed — runs are ephemeral, registry is in-memory.
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

export const registry = {
  create({ sessionId, userId }) {
    const runId = newRunId();
    runs.set(runId, new RunState({ runId, sessionId, userId }));
    return runId;
  },

  attachRunner(runId, runner, controller) {
    const s = runs.get(runId);
    if (!s) return false;
    s.runner = runner;
    s.controller = controller;
    return true;
  },

  /**
   * Subscribe `res` to the run's event stream. Sets SSE headers, sends
   * an initial keepalive comment so the client sees "connection open"
   * even if no events arrive for a while, and registers cleanup on req
   * close. Returns true on success; false (and writes 404) if the run
   * is unknown or already ended.
   */
  subscribe(runId, req, res) {
    const s = runs.get(runId);
    if (!s || s.ended) {
      // Only meaningful when res.status exists (Express Response). The
      // socket mock in tests doesn't carry .status; write a plain 404
      // status line so the wire is still informative for HTTP clients.
      if (typeof res.status === 'function') {
        res.status(404).json({ error: 'run not found or ended' });
      } else {
        res.statusCode = 404;
        if (typeof res.end === 'function') res.end();
      }
      return false;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Disable request buffering on the server side too — Node will flush
    // each write immediately rather than coalescing into the socket buffer.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    s.subscribers.add(res);

    // Immediate keepalive so curl/EventSource confirms the stream is alive
    // before the first real event arrives.
    try { res.write(`: open\n\n`); } catch { /* dead socket */ }

    const ka = setInterval(() => {
      try { res.write(`: keepalive ${Date.now()}\n\n`); }
      catch { cleanup(); }
    }, KEEPALIVE_MS);
    s.keepalives.set(res, ka);

    function cleanup() {
      clearInterval(ka);
      s.keepalives.delete(res);
      s.subscribers.delete(res);
    }
    req.on('close', cleanup);
    return true;
  },

  /**
   * Fan-out one event frame to every active subscriber. Silently skips
   * dead writers. Safe to call from inside the runner onEvent callback —
   * subscribers are isolated so one slow consumer can't block emit().
   */
  emit(runId, eventName, data) {
    const s = runs.get(runId);
    if (!s || s.ended) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of s.subscribers) {
      try { res.write(frame); }
      catch { /* dead socket — close handler will clean up */ }
    }
  },

  /**
   * Kill the runner. Ownership-checked: a user can only stop their own
   * runs. No-op (returns false) for unknown runs or wrong owner — the
   * caller surfaces that as 403/404.
   */
  stop(runId, userId) {
    const s = runs.get(runId);
    if (!s) return false;
    if (s.userId !== userId) return false;
    if (s.ended) return true;
    if (s.controller) {
      try { s.controller.kill(); } catch { /* runner already exited */ }
    }
    return true;
  },

  /**
   * Terminal: write a closing comment to every subscriber, end their
   * responses, and schedule row deletion after a grace period so a late
   * reconnect (network blip) can still see "run ended" via the 404 path
   * rather than crashing on a missing key.
   */
  end(runId, { immediate = false } = {}) {
    const s = runs.get(runId);
    if (!s || s.ended) return;
    s.ended = true;
    for (const [res, ka] of s.keepalives) {
      clearInterval(ka);
      try { res.write(`: end\n\n`); res.end(); } catch { /* ignore */ }
    }
    s.keepalives.clear();
    s.subscribers.clear();
    // Default 60s grace so a late reconnect (network blip) still sees
    // a clean 404 instead of crashing on a missing key. Tests pass
    // {immediate: true} to keep the event loop empty between runs.
    s.graceTimer = setTimeout(() => runs.delete(runId), immediate ? 0 : GRACE_MS);
  },

  /** For tests / introspection. */
  _has(runId) {
    return runs.has(runId);
  },
};

export default registry;
