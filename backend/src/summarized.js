/**
 * Render the session summary as a <system> block for the current chat
 * turn. Returns '' when no summary exists for the session.
 *
 * Block sits BELOW facts/recall in the system prompt composition so
 * the order stays: persona → facts → recall → this-session summary
 * → history.
 *
 * The summary is per-session (keyed by session_id) — no per-user
 * bleed possible. The recent RECENT_TAIL messages from the actual
 * history stay verbatim so the model can reconcile the summary
 * against the recent turns.
 */

import db from "./db/index.js";

const SUMMARY_SNIPPET_MAX = 1500;

export function renderSessionSummaryBlock(sessionId) {
  if (!sessionId) return "";
  const row = db
    .prepare(
      `SELECT summary, summarized_up_to FROM session_summaries WHERE session_id = ?`
    )
    .get(sessionId);
  if (!row) return "";
  const trimmed = String(row.summary).replace(/\s+/g, " ").slice(0, SUMMARY_SNIPPET_MAX);
  return `<system>\nSummary of this session's earlier turns (newer turns are below verbatim):\n${trimmed}\n</system>`;
}

export const _internals = { SUMMARY_SNIPPET_MAX };