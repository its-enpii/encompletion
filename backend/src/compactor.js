/**
 * Conversation compactor — turns a long transcript into a rolling
 * summary via the configured LLM. The compactor-worker overwrites the
 * session_summaries row in place (PRIMARY KEY on session_id), so we
 * always hold the freshest compaction.
 *
 * Why rolling: one summary per session is cheaper to maintain than
 * layered hierarchies, and the model only needs the gist of older
 * context (it has the recent turns verbatim).
 *
 * Mirrors extractor.js shape so a future shared abstraction is easy.
 *
 * Per-user provider
 * ─────────────────
 * The caller (compactor-worker.js) resolves the per-user provider via
 * `resolveProviderFor` and passes it in. `compactTranscript` accepts
 * either an object `{ baseUrl, apiKey, model }` (new path) or
 * `undefined` for backwards-compat tests. The HTTP layer never reads
 * env vars; an absent provider raises a clear `LLMNotConfigured`.
 */

const SYSTEM = `You compress chat transcripts into concise summaries.
Rules:
- Preserve: user-stated facts, decisions made, code/files discussed,
  open questions, current task state, errors and resolutions.
- Drop: pleasantries, repeated questions, the model's own process
  narration, anything covered more recently.
- Output plain prose, ≤ 800 words. No markdown headers, no bullet lists
  unless genuinely list-shaped.
- Begin with a 1-sentence "Topic:" line so future reads can scan fast.
- Mention any tool calls that materially shaped the conversation
  (e.g. "ran tests, 3 failed" — not every tool invocation).`;

const MAX_SUMMARY_CHARS = 6000;

async function callCompactorLLM({ system, user, provider }) {
  if (!provider || !provider.baseUrl || !provider.apiKey || !provider.model) {
    throw new Error('compactor: no provider (LLM_NOT_CONFIGURED)');
  }
  const r = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      stream: false,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`compactor HTTP ${r.status}`);
  const j = await r.json();
  return String(j?.choices?.[0]?.message?.content || "").trim();
}

// Test-only injection point so the worker test can mock without a
// network round-trip. Defaults to the real call.
let _llmImpl = callCompactorLLM;
export function _setCompactorLLMForTests(fn) { _llmImpl = fn; }
export function _resetCompactorLLMForTests() { _llmImpl = callCompactorLLM; }

export async function compactTranscript(messages, provider) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").slice(0, 1500)}`)
    .join("\n");
  let raw;
  try {
    raw = await _llmImpl({ system: SYSTEM, user: transcript, provider });
  } catch {
    return "";
  }
  return raw.slice(0, MAX_SUMMARY_CHARS);
}

export const _internals = { SYSTEM, MAX_SUMMARY_CHARS, callCompactorLLM };