/**
 * Memory extractor worker — idle-detect loop that runs the LLM extractor
 * against quiet sessions and stores the candidate facts.
 *
 * Why idle detection, not per-turn: a per-turn call would be expensive on
 * long sessions and would race with the user typing the next message.
 * Idle detection waits for sessions.updated_at to be older than
 * IDLE_THRESHOLD_MS, then extracts once per "natural pause".
 *
 * Idempotency: last_memory_extracted_at on each session is bumped after
 * each run. The SQL filter requires updated_at > last_memory_extracted_at
 * (or last_memory_extracted_at IS NULL) so a quiet session isn't
 * repeatedly extracted on every poll.
 *
 * Opt-out: per-user auto_memory_enabled setting on user_settings; default
 * is ON, but users can disable from the Memory dialog.
 *
 * Embed sessions: scoped to owner_type='user' so platform user chat only.
 * Tenant widget sessions live under owner_type='tenant' and never feed
 * the platform user's memory facts.
 */

import db from "./db/index.js";
import { extractFactsFromTranscript } from "./extractor.js";
import { upsertFact } from "./memory.js";

const POLL_MS = Number(process.env.MEMORY_POLL_MS) || 60_000;
const IDLE_THRESHOLD_MS = Number(process.env.MEMORY_IDLE_MS) || 5 * 60_000; // 5 min
const MAX_TRANSCRIPT_MESSAGES = 40;

let timer = null;
let runningPromise = null;

export function startExtractorWorker() {
  if (timer) return; // singleton — already running
  // Boot tick catches up on whatever idle sessions accumulated while
  // the server was down. Errors are caught inside runOnce.
  runningPromise = runOnce();
  timer = setInterval(() => {
    if (runningPromise) return; // skip overlapping ticks if a run is slow
    runningPromise = runOnce().finally(() => {
      runningPromise = null;
    });
  }, POLL_MS);
  // Don't keep the event loop alive solely for this timer — important
  // for test runs that import the module but don't want it pinned.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopExtractorWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  runningPromise = null;
}

export async function runOnce() {
  // Sessions: idle for at least IDLE_THRESHOLD_MS AND not yet extracted
  // since their last user activity. The platform-side filter
  // (owner_type='user') keeps embed/tenant sessions out of the user's
  // personal memory.
  const idleSeconds = Math.max(1, Math.floor(IDLE_THRESHOLD_MS / 1000));
  const sessions = db
    .prepare(
      `SELECT id, user_id
         FROM sessions
        WHERE datetime(updated_at) < datetime('now', ?)
          AND (last_memory_extracted_at IS NULL
               OR datetime(last_memory_extracted_at) < datetime(updated_at))
          AND owner_type = 'user'`
    )
    .all(`-${idleSeconds} seconds`);

  for (const s of sessions) {
    await processSession(s);
  }
}

async function processSession(s) {
  try {
    // Per-user opt-out. Default ON when no settings row exists.
    const setting = db
      .prepare(`SELECT auto_memory_enabled FROM user_settings WHERE user_id = ?`)
      .get(s.user_id);
    if (setting && setting.auto_memory_enabled === 0) return;

    const messages = db
      .prepare(
        `SELECT role, content FROM messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(s.id, MAX_TRANSCRIPT_MESSAGES)
      .reverse();
    // Need at least one user + one assistant turn. Pure clarification
    // questions (user-only) don't tell us anything user-stated.
    const hasUser = messages.some((m) => m.role === "user");
    const hasAssistant = messages.some((m) => m.role === "assistant");
    if (!hasUser || !hasAssistant) return;

    const facts = await extractFactsFromTranscript(messages);
    for (const f of facts) {
      try {
        // UNIQUE(user_id,key) collision → updates value (and keeps the
        // existing source via memory.js's update path).
        upsertFact(s.user_id, f.key, f.value, "auto");
      } catch (e) {
        // Per-fact errors (validation, per-user cap) don't abort the
        // batch — log and move on.
        console.warn(`[memory-worker] skip fact "${f.key}": ${e?.message || e}`);
      }
    }
    db.prepare(
      `UPDATE sessions SET last_memory_extracted_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(s.id);
  } catch (e) {
    // Per-session errors don't kill the worker; the next tick retries.
    console.error(`[memory-worker] session ${s.id} failed:`, e?.message || e);
  }
}

export const _internals = { POLL_MS, IDLE_THRESHOLD_MS, MAX_TRANSCRIPT_MESSAGES };