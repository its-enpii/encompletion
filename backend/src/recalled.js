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
const MIN_RECALL_SCORE = 0.45;

export async function renderRecalledContextBlock(userId, query, sessionId = null, projectId = null) {
  const { block } = await resolveRecall(userId, query, sessionId, projectId);
  return block;
}

/**
 * Same as renderRecalledContextBlock but also returns the raw hits so
 * the runner can emit a recall event to the FE for the "sources used"
 * badge. Returns { block, hits } where hits is an array of
 * { source_kind, source_id, label, score } (no content — keeps the
 * payload small and avoids leaking chunk text to the wire).
 */
export async function resolveRecall(userId, query, sessionId = null, projectId = null) {
  if (!userId || typeof query !== 'string') return { block: '', hits: [] };
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LEN) return { block: '', hits: [] };

  let rawHits;
  try {
    rawHits = await rag.query(trimmed, {
      topK: RECALLED_TOPK,
      scopeUserId: userId,
      sessionId,
      // Limit project_knowledge chunks to the active session's project so
      // a chunk from another project owned by the same user doesn't leak
      // into this chat's recall block.
      projectId,
    });
  } catch {
    return { block: '', hits: [] };
  }
  const filtered = (rawHits || []).filter((h) => (h.score ?? 0) >= MIN_RECALL_SCORE);
  if (filtered.length === 0) return { block: '', hits: [] };

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

  const block = `<system>\nRecalled context from your past chats (most relevant first):\n${lines.join('\n')}\n</system>`;
  // Strip content/score.fractional-numbers and keep just identifiers +
  // rounded score so the FE can render "3 sources" without shipping
  // chunk bodies over the wire.
  const hits = deduped.map((h) => ({
    source_kind: h.source_kind,
    source_id: h.source_id,
    label: h.source_kind === 'user_message' ? `past-message` : h.label,
    score: Number((h.score ?? 0).toFixed(3)),
  }));
  return { block, hits };
}

export const _internals = { RECALLED_TOPK, RECALLED_SNIPPET_MAX, MIN_QUERY_LEN, MIN_RECALL_SCORE };