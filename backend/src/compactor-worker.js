/**
 * Conversation compaction worker — idle-batch loop that summarizes
 * the older portion of long session transcripts. Runs on its own
 * timer, parallel to extractor/indexer workers.
 *
 * Compaction flow per session:
 *  1. Load all messages (id ASC, role IN user/assistant).
 *  2. Slice: HEAD = older (everything except last RECENT_TAIL).
 *  3. LLM → summary text. Upsert into session_summaries (PRIMARY KEY
 *     on session_id → UPDATE in place).
 *  4. Bump sessions.last_compacted_at.
 *
 * Idempotency: last_compacted_at bumped after run. Worker skips when
 * updated_at hasn't moved past last_compacted_at.
 *
 * Opt-out: none at v1. Embed/tenant sessions excluded via owner_type.
 *
 * Cost: BATCH_MAX sessions per tick + Haiku-class model env override.
 */

import db from "./db/index.js";
import { compactTranscript } from "./compactor.js";

const POLL_MS = Number(process.env.COMPACTOR_POLL_MS) || 5 * 60_000;
const BATCH_MAX = Number(process.env.COMPACTOR_BATCH_MAX) || 5;
const THRESHOLD = Number(process.env.COMPACTOR_THRESHOLD) || 30;
const RECENT_TAIL = Number(process.env.COMPACTOR_RECENT_TAIL) || 12;
const ERROR_BACKOFF_MS = 30_000;

let timer = null;
let runningPromise = null;

export function startCompactorWorker() {
  if (timer) return; // singleton
  runningPromise = runOnce().catch(() => {});
  timer = setInterval(() => {
    if (runningPromise) return; // skip overlapping ticks
    runningPromise = runOnce().finally(() => {
      runningPromise = null;
    });
  }, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopCompactorWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  runningPromise = null;
}

export async function runOnce() {
  // Sessions with enough messages to need compaction, that have changed
  // since last compaction. owner_type filter keeps embed/tenant
  // sessions out of the platform user's compaction pipeline.
  const candidates = db
    .prepare(
      `SELECT s.id AS session_id, s.user_id
         FROM sessions s
        WHERE s.archived_at IS NULL
          AND s.owner_type = 'user'
          AND (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) > ?
          AND (s.last_compacted_at IS NULL
               OR datetime(s.last_compacted_at) < datetime(s.updated_at))
        ORDER BY s.updated_at DESC
        LIMIT ?`
    )
    .all(THRESHOLD, BATCH_MAX);

  for (const s of candidates) {
    await processSession(s);
  }
}

async function processSession(s) {
  try {
    // All user/assistant messages in chronological order.
    const all = db
      .prepare(
        `SELECT id, role, content FROM messages
          WHERE session_id = ? AND role IN ('user', 'assistant')
          ORDER BY id ASC`
      )
      .all(s.session_id);
    if (all.length <= RECENT_TAIL) return; // nothing old enough to summarize

    // older = head, drop the last RECENT_TAIL for verbatim history.
    const older = all.slice(0, all.length - RECENT_TAIL);
    const summarizedUpTo = older[older.length - 1].id;

    const summary = await compactTranscript(older);
    if (!summary) return; // LLM hiccup — try again next tick

    const existing = db
      .prepare(`SELECT session_id FROM session_summaries WHERE session_id = ?`)
      .get(s.session_id);
    if (existing) {
      db.prepare(
        `UPDATE session_summaries
            SET summary = ?, summarized_up_to = ?, model = ?, updated_at = CURRENT_TIMESTAMP
          WHERE session_id = ?`
      ).run(
        summary,
        summarizedUpTo,
        process.env.LLM_COMPACT_MODEL || "compactor",
        s.session_id
      );
    } else {
      db.prepare(
        `INSERT INTO session_summaries (session_id, summary, summarized_up_to, model)
         VALUES (?, ?, ?, ?)`
      ).run(
        s.session_id,
        summary,
        summarizedUpTo,
        process.env.LLM_COMPACT_MODEL || "compactor"
      );
    }
    db.prepare(
      `UPDATE sessions SET last_compacted_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(s.session_id);
  } catch (e) {
    // Per-session errors don't kill the worker; the next tick retries.
    console.warn(`[compactor-worker] session ${s.session_id} failed:`, e?.message || e);
    await new Promise((res) => setTimeout(res, ERROR_BACKOFF_MS));
  }
}

export const _internals = { POLL_MS, BATCH_MAX, THRESHOLD, RECENT_TAIL };