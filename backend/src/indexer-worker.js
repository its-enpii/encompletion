/**
 * Cross-session recall indexer — idle-batch worker that embeds
 * un-indexed messages and links them to their session for the recall
 * path.
 *
 * Runs on its own timer (parallel to extractor-worker). Each tick
 * caps at BATCH_MAX messages so the embed budget per tick is bounded;
 * back-fill for a heavy user finishes in a few ticks.
 *
 * Idempotency: messages.last_indexed_at is stamped after a successful
 * upsert. Re-runs pick up where they left off.
 *
 * Embed-provider errors: a tick-level backoff (30s) prevents us from
 * hammering a broken provider; surviving ticks retry the same unindexed
 * rows on the next poll.
 *
 * Per-user LLM settings
 * ──────────────────────
 * Embeddings are intentionally a global surface (EMBED_PROVIDER +
 * LLM_BASE_URL env at the backend) — see embedder.js. The per-user
 * LLM config that landed with this feature does NOT cover embedding
 * credentials. The EXISTS clause in `runOnce()` filters out messages
 * whose session owner has not configured LLM settings yet, so the
 * per-tick embed cost is bounded the same way the other workers are.
 * It costs the user nothing extra — they're already not chatting —
 * but it keeps the indexer's stderr clean during onboarding.
 *
 * Scope: sessions with a real user_id.
 * sessions are out of scope — those use their own RAG path.
 */

import db from './db/index.js';
import { indexMessage } from './indexer.js';

const POLL_MS = Number(process.env.INDEXER_POLL_MS) || 60_000;
const BATCH_MAX = Number(process.env.INDEXER_BATCH_MAX) || 50;
const EMBED_PROVIDER_ERROR_BACKOFF_MS = 30_000;

let timer = null;
let runningPromise = null;

export function startIndexerWorker() {
  if (timer) return; // singleton
  // Boot tick catches up on whatever queued up while the server was down.
  runningPromise = runOnce().catch(() => {});
  timer = setInterval(() => {
    if (runningPromise) return; // skip overlapping ticks
    runningPromise = runOnce().finally(() => {
      runningPromise = null;
    });
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopIndexerWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  runningPromise = null;
}

export async function runOnce() {
  // Oldest un-indexed messages from sessions whose owner has
  // configured LLM settings (EXISTS clause). Sessions without
  // settings don't need their content indexed yet — there's no
  // chat that could recall them. Once the user onboards, the next
  // tick picks them up via the still-NULL last_indexed_at.
  // ORDER BY id ASC so the oldest pending rows go first; back-fill is FIFO.
  const rows = db
    .prepare(
      `SELECT m.id AS message_id, m.session_id, m.content
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.last_indexed_at IS NULL
          AND s.user_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM user_llm_settings uls
             WHERE uls.user_id = s.user_id
               AND uls.base_url <> ''
               AND uls.api_key_blob IS NOT NULL
          )
        ORDER BY m.id ASC
        LIMIT ?`
    )
    .all(BATCH_MAX);

  for (const r of rows) {
    try {
      await indexMessage({
        messageId: r.message_id,
        content: r.content,
        sessionId: r.session_id,
      });
    } catch (e) {
      // Per-message errors (validation, embed failure) don't kill the
      // tick. Stop early so the next tick gets a chance — partial
      // batches are fine; we resume from where we left off.
      console.warn(`[indexer-worker] skip message ${r.message_id}: ${e?.message || e}`);
      await new Promise((res) => setTimeout(res, EMBED_PROVIDER_ERROR_BACKOFF_MS));
      break;
    }
  }
}

export const _internals = { POLL_MS, BATCH_MAX, EMBED_PROVIDER_ERROR_BACKOFF_MS };