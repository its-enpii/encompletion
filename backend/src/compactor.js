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

async function callCompactorLLM({ system, user }) {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "";
  // Operator can pick a cheaper model for compaction. Falls back to the
  // same model the extractor uses (already optimized for short calls),
  // then to the chat default, then to a Haiku-class id.
  const model = process.env.LLM_COMPACT_MODEL
    || process.env.LLM_EXTRACT_MODEL
    || process.env.LLM_DEFAULT_MODEL
    || "claude-haiku-4-5";
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
    },
    body: JSON.stringify({
      model,
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

export async function compactTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").slice(0, 1500)}`)
    .join("\n");
  let raw;
  try {
    raw = await _llmImpl({ system: SYSTEM, user: transcript });
  } catch {
    return "";
  }
  return raw.slice(0, MAX_SUMMARY_CHARS);
}

export const _internals = { SYSTEM, MAX_SUMMARY_CHARS, callCompactorLLM };