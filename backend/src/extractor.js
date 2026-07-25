/**
 * Memory auto-extractor — takes a chat transcript, asks the configured
 * LLM (LLM_EXTRACT_MODEL, default claude-haiku-4-5) to return a strict
 * JSON list of user facts, and returns the parsed/sanitized candidates.
 *
 * Design choices:
 *  - Non-streaming: payload is tiny (<2KB), SSE framing adds nothing.
 *  - Temperature 0: deterministic-ish output for the same transcript.
 *  - Snake/lowercase keys: matches the existing FACT_KEY_RE on
 *    user_memory_facts.key (which expects letters/digits/_/-).
 *  - Output is defensive-parsed: we accept fenced ```json```, stray
 *    prose around the object, or bad shape — and silently degrade to
 *    "no facts extracted" instead of throwing so the worker stays
 *    resilient.
 */

const SYSTEM = `You extract persistent user facts from chat transcripts.
Output strict JSON only: {"facts":[{"key":"<snake_case>","value":"<short>"}]}
Rules:
- Only facts the user explicitly stated about themselves: their work, location, preferences, language, role, tools, or background.
- Skip anything transient (current task, opinions about today's chat).
- Skip anything the model inferred or assumed — only what the user said.
- key must be 1-40 chars, snake_case or kebab-case, lowercase, letter-first.
- value under 200 chars, no newlines.
- At most 8 facts per call. Empty array if nothing worth saving.`;

const MAX_FACTS = 8;
const MAX_VALUE = 200;
const TRANSCRIPT_TAIL = 40; // last 20 user/assistant pairs max
const PER_MESSAGE_CAP = 800; // chars per message — clips huge pastes

async function callExtractorLLM({ system, user }) {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "";
  const model = process.env.LLM_EXTRACT_MODEL || "claude-haiku-4-5";
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
  if (!r.ok) throw new Error(`extractor HTTP ${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || "";
  return String(text);
}

// Test-only injection point so the worker test can mock without a
// network round-trip. Defaults to the real call. Resettable.
let _llmImpl = callExtractorLLM;
export function _setExtractorLLMForTests(fn) { _llmImpl = fn; }
export function _resetExtractorLLMForTests() { _llmImpl = callExtractorLLM; }

export async function extractFactsFromTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const transcript = messages
    .slice(-TRANSCRIPT_TAIL)
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const text = String(m.content || "").slice(0, PER_MESSAGE_CAP);
      return `${role}: ${text}`;
    })
    .join("\n");
  let raw;
  try {
    raw = await _llmImpl({ system: SYSTEM, user: transcript });
  } catch {
    return [];
  }
  let parsed;
  try {
    // Robust extraction: handle ```json fences, leading prose, trailing
    // commentary. We grab the first {...} JSON-looking block.
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenceMatch ? fenceMatch[1] : raw;
    const objMatch = candidate.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(objMatch ? objMatch[0] : candidate);
  } catch {
    return [];
  }
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts
    .filter((f) => f && typeof f.key === "string" && typeof f.value === "string")
    .map((f) => ({
      key: f.key.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40),
      value: String(f.value).replace(/\s+/g, " ").trim().slice(0, MAX_VALUE),
    }))
    .filter((f) => f.key.length >= 1 && /^[a-z]/.test(f.key) && f.value.length >= 1)
    .slice(0, MAX_FACTS);
}

export const _internals = { SYSTEM, MAX_FACTS, MAX_VALUE, TRANSCRIPT_TAIL };