/**
 * Cross-session recall block.
 *
 * Mirrors memory.js renderMemoryFactsBlock: takes (userId, query),
 * returns a `<system>`-tagged block (or '' when there are no hits).
 * Caller concatenates below the memory-facts block in runLLM().
 *
 * Behavior:
 *  - Skips short queries (< MIN_QUERY_LEN) so "ok" / "thanks" don't
 *    trigger an embed call.
 *  - Returns '' on any error — the recall block must NEVER block chat.
 *  - Top-K=3, 500-char snippet cap → ~1.5KB total. Bounded token cost.
 *  - Passes sessionId so rag.query filters out the active session's
 *    chunks (cross-session only — current session is already in
 *    history). rag.js post-filters via embeddings_session as
 *    defense-in-depth.
 */

import rag from './rag.js';

const RECALLED_TOPK = 3;
const RECALLED_SNIPPET_MAX = 500;
const MIN_QUERY_LEN = 12;
// Floor for cosine similarity. Hits below this are unrelated noise —
// embedding models routinely return ~0.2-0.3 for unrelated queries,
// which the LLM then treats as "I should research this" and burns
// tool_use rounds on a side-quest instead of answering. Without this
// floor, the recall block grows into a slop list and the model over-
// reasons on trivia prompts (3 text chats in sequence → runner
// exhausts max tool-call rounds).
const MIN_RECALL_SCORE = 0.55;

export async function renderRecalledContextBlock(userId, query, sessionId = null) {
  if (!userId || typeof query !== 'string') return '';
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LEN) return '';

  let hits;
  try {
    hits = await rag.query(trimmed, {
      topK: RECALLED_TOPK,
      scopeUserId: userId,
      sessionId,
    });
  } catch {
    return '';
  }
  const filtered = (hits || []).filter((h) => (h.score ?? 0) >= MIN_RECALL_SCORE);
  if (filtered.length === 0) return '';

  // Dedup near-identical snippets. After many test runs (or a user
  // asking the same thing repeatedly) the same chunk text accumulates
  // dozens of times in the index. Without dedup the LLM sees "PONG PONG
  // PONG" and gets confused. Normalize whitespace + lowercase + take a
  // 80-char fingerprint; the first hit at a given fingerprint wins.
  const seen = new Set();
  const deduped = [];
  for (const h of filtered) {
    const fp = String(h.content).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
    if (seen.has(fp)) continue;
    seen.add(fp);
    deduped.push(h);
  }

  const lines = deduped.map((h) => {
    const label = h.source_kind === 'user_message' ? `past-message` : h.label;
    const excerpt = String(h.content).replace(/\n+/g, ' ').slice(0, RECALLED_SNIPPET_MAX);
    return `- (${label}) ${excerpt}`;
  });

  return `<system>\nRecalled context from your past chats (most relevant first):\n${lines.join('\n')}\n</system>`;
}

export const _internals = { RECALLED_TOPK, RECALLED_SNIPPET_MAX, MIN_QUERY_LEN, MIN_RECALL_SCORE };