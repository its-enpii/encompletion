"use client";

/**
 * Run stream — replaces socket.io-client for chat streaming.
 *
 * Each prompt opens a fresh EventSource against
 *   /api/sessions/:id/runs/:runId/stream
 * and listens for typed events. Auth uses a ?token= query because
 * EventSource can't set custom headers — middleware already supports it.
 *
 * Three exports:
 *   startRun(payload)         POST /api/sessions/:id/runs  → { runId, sessionId }
 *   subscribeRun({...})       open EventSource, wire handlers, return {unsubscribe, source}
 *   stopRun(sid, runId)       POST /api/sessions/:id/runs/:runId/stop
 */

import { getToken, authFetch } from "./auth";

// SSE event names — must match the names server.js#run-registry writes.
// Keep this list in sync with backend/src/run-registry.js comments.
export type RunEventName =
  | "start"
  | "system"
  | "text"
  | "stderr"
  | "tool_use"
  | "tool_result"
  | "artifact"
  | "artifact_dup"
  | "artifact_rejections"
  | "message_saved"
  | "result"
  | "stopped"
  | "tick"
  | "done"
  | "error";

export type RunEventHandler = (payload: any) => void;

export type RunEventHandlers = Partial<Record<RunEventName, RunEventHandler>> & {
  /** Fires when the SSE connection is established (open event). */
  onOpen?: () => void;
  /**
   * Fires when the connection errors or closes unexpectedly. EventSource
   * auto-reconnects on transient drops — the chat layer should NOT
   * flip streaming=false on this; it surfaces as a status hint only.
   */
  onError?: (event: Event) => void;
};

export type SubscribeRunOpts = {
  sessionId: number;
  runId: number;
  handlers: RunEventHandlers;
};

export type StartRunPayload = {
  sessionId: number | null;
  prompt: string;
  model: string;
  projectId?: number | null;
  systemPrompt?: string | null;
  attachments?: any[];
  effort?: string;
  regenerate?: boolean;
};

export type StartRunResponse = { runId: number; sessionId: number };

/**
 * Open an EventSource for an active run. Returns a handle whose
 * `unsubscribe()` closes the stream cleanly. The caller wires typed
 * handlers via opts.handlers; unknown handler keys are ignored.
 *
 * If the run has already ended (race with auto-reconnect), the server
 * returns 404 and the EventSource will hit onerror — caller can branch
 * to loadSession() to recover the persisted transcript.
 */
export function subscribeRun(opts: SubscribeRunOpts): { unsubscribe: () => void; source: EventSource } {
  const token = getToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  const url = `/api/sessions/${opts.sessionId}/runs/${opts.runId}/stream?${params.toString()}`;

  const source = new EventSource(url);

  // Wire typed handlers. Skip keys starting with "on" that aren't real
  // event names (onOpen / onError are special, not SSE events).
  const TYPED: RunEventName[] = [
    "start", "system", "text", "stderr",
    "tool_use", "tool_result", "artifact", "artifact_dup", "artifact_rejections",
    "message_saved", "result", "stopped", "tick", "done", "error",
  ];
  for (const name of TYPED) {
    const fn = opts.handlers[name];
    if (typeof fn !== "function") continue;
    source.addEventListener(name, (ev: MessageEvent) => {
      try { fn(JSON.parse(ev.data)); }
      catch { /* malformed frame — skip silently, the runner will close the stream */ }
    });
  }

  source.addEventListener("open", () => opts.handlers.onOpen?.());
  source.addEventListener("error", (e) => opts.handlers.onError?.(e));

  return {
    source,
    unsubscribe: () => {
      try { source.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Start a new run. POSTs to the session's runs endpoint; backend creates
 * the assistant row, kicks the runner, and returns { runId, sessionId }
 * so the client can immediately open the SSE stream.
 *
 * When `sessionId` is null the backend creates a new session row from
 * the prompt text. Callers that need the new id should await this and
 * then router.push(`/chat/${sessionId}`) BEFORE opening the stream so
 * the route's [sessionId] effect attaches the handlers in time.
 */
export async function startRun(payload: StartRunPayload): Promise<StartRunResponse> {
  const path = payload.sessionId
    ? `/api/sessions/${payload.sessionId}/runs`
    : `/api/sessions/new/runs`;
  const body: any = { ...payload };
  // `sessionId` is encoded in the URL — don't send it in the body too
  // (the "new" path treats it as create-on-demand).
  delete body.sessionId;
  const r = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) detail = d.error; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return r.json();
}

/**
 * Kill the runner for an active run. Idempotent — returns ok whether
 * the run is still active or has already ended. Throws on ownership
 * failure (403) so callers can branch.
 */
export async function stopRun(sessionId: number, runId: number): Promise<void> {
  const r = await authFetch(`/api/sessions/${sessionId}/runs/${runId}/stop`, {
    method: "POST",
  });
  if (!r.ok && r.status !== 404) {
    // 404 means the run already ended — that's fine, we wanted to stop
    // it anyway. Other errors (403, 500) propagate.
    let detail = `HTTP ${r.status}`;
    try { const d = await r.json(); if (d?.error) detail = d.error; } catch { /* ignore */ }
    throw new Error(detail);
  }
}
