/**
 * Per-message embedding wrapper for cross-session recall.
 *
 * The indexer-worker calls this for every unindexed message. We:
 *   1. truncate long pastes (cost cap),
 *   2. embed via the existing rag.indexSource pipeline (which writes
 *      embeddings_chunk + embeddings_session),
 *   3. bump messages.last_indexed_at so the worker doesn't re-process.
 *
 * rag.indexSource handles the (kind, source_id) replace semantics, so
 * re-running on a message is idempotent.
 */

import db from './db/index.js';
import rag from './rag.js';

const EMBED_USER_MSG_MAX = 2000;

export async function indexMessage({ messageId, content, sessionId }) {
  if (!messageId || typeof content !== 'string') return { chunks: 0 };
  const trimmed = content.trim();
  if (trimmed.length === 0) return { chunks: 0 };
  const sliced = trimmed.length > EMBED_USER_MSG_MAX
    ? trimmed.slice(0, EMBED_USER_MSG_MAX)
    : trimmed;
  await rag.indexSource({
    kind: 'user_message',
    id: messageId,
    content: sliced,
    sessionId,
  });
  db.prepare(
    `UPDATE messages SET last_indexed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(messageId);
  return { chunks: 1 };
}

export const _internals = { EMBED_USER_MSG_MAX };