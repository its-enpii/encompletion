/**
 * LLM runner — OpenAI-compatible HTTP chat completions with SSE
 * streaming. Replaces the legacy Claude CLI subprocess. Emits the
 * same event vocabulary claude-runner does so the rest of the chat
 * pipeline (server.js socket handler, frontend Chat) keeps working
 * unchanged:
 *
 *   {type:'system',  subtype:'init',  ...}
 *   {type:'text',    text:string}
 *   {type:'tool_use', id, name, input}
 *   {type:'tool_result', tool_use_id, content, is_error}
 *   {type:'result',  is_error, total_cost_usd, duration_ms,
 *                     usage:{input_tokens,output_tokens}}
 *   {type:'stderr',  text}
 *
 * Returns a controller compatible with server.js expectations:
 *   { kill: () => void, proc: EventEmitter }
 *
 * The EventEmitter fires 'close' when the streaming loop ends
 * (success or failure), so server.js can persist the assistant
 * message without further changes.
 */

import { EventEmitter } from "node:events";
import { runTool } from "./tools.js";
import { skillTools, runSkillTool } from "./skill_loader.js";
import { hashArtifact } from "./artifact-detector.js";
import { renderMemoryFactsBlock } from "./memory.js";
import { renderRecalledContextBlock } from "./recalled.js";
import { renderSessionSummaryBlock } from "./summarized.js";
import db from "./db/index.js";

const SYSTEM_PROMPT = `You are a coding assistant. You have read/write
access to a working directory via the provided tools. Prefer small,
focused changes. Always read a file before editing it unless the user
provided the full contents verbatim. Keep prose concise.

You also have Skill.list and Skill.read tools. When a user request
matches a skill's description, call Skill.list first to confirm the
catalog, then Skill.read to load the full procedure before acting.
This mirrors the same scoped-procedure workflow Claude Code skills
provide, but invoked explicitly via tool calls.

WebFetch: when the user asks about a public URL, current events,
library versions, or anything your training data may be stale or
wrong about, call WebFetch to look it up before answering. Prefer
looking up the specific URL the user mentioned (or implied — e.g.
"the latest docs") rather than guessing. If the user explicitly says
"don't look it up" or the question is purely from prior knowledge,
skip the fetch. Cite the URL you fetched in your reply so the user
can verify.

Artifacts: you have an EmitArtifact tool. Use it to publish any
substantive output the user will want to preview, copy, save, or
render — a complete file's full contents, a UI snippet they would
open in a browser, a config blob, a markdown doc, etc. Pass
{type, title, language?, content}. Skip it for short syntax examples
or short snippets that are only there to illustrate a sentence in
prose. Do NOT also dump the same content into a fenced code block
in your reply when you call EmitArtifact — the artifact panel is the
view; your reply text should just describe what was published.

When you finish a turn, do NOT emit a closing "ask for next" — wait
for the user's next message.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command. Returns combined stdout/stderr. Use for git, ls, grep, build/test invocations.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          deadline_ms: { type: "integer" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file from disk. Files larger than ~4MB require start_line/end_line.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file, replacing any existing contents. Refuses to write outside the working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description: "Search-and-replace edit. old_string must match exactly once unless replace_all=true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "List files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search file contents with regex.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          include_glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebFetch",
      description:
        "Fetch a URL over HTTP(S) and return the response body as text. " +
        "HTML is stripped to plain text; JSON / XML / text are returned as-is. " +
        "Use this when the user asks you to read a webpage, check a public " +
        "API, or pull down documentation. Only http(s) URLs are allowed; " +
        "private / loopback addresses are rejected.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
          max_bytes: { type: "integer", description: "Cap on response body size. Default 256KB." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "EmitArtifact",
      description:
        "Publish a code block, document, or other sizable output as an " +
        "artifact the user can preview, copy, save, or render in the chat " +
        "side panel. Use this whenever your reply contains something the " +
        "user is likely to want as a standalone object — a complete file's " +
        "contents, a UI snippet the user would preview in a browser, a " +
        "config blob they want to save, etc. Do NOT call this for tiny " +
        "one-liner syntax examples or for fenced blocks that are just " +
        "illustrating a sentence in prose.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["html", "react", "svg", "markdown", "code"],
            description:
              "How the artifact should be rendered. Use 'html' for full " +
              "documents, 'react' for JSX/TSX components, 'svg' for vector " +
              "graphics, 'markdown' for prose docs, 'code' for everything " +
              "else (JSON, YAML, scripts, etc.).",
          },
          title: {
            type: "string",
            description:
              "Short label for the artifact card (e.g. 'login.html', " +
              "'UserCard.tsx'). Keep it under 80 chars.",
          },
          language: {
            type: "string",
            description:
              "Original language identifier if 'type' is 'code' " +
              "(e.g. 'python', 'rust', 'json').",
          },
          content: {
            type: "string",
            description: "The full content of the artifact.",
          },
        },
        required: ["type", "title", "content"],
      },
    },
  },
];

const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const DEFAULT_TOOL_DEADLINE_MS = 30_000;
const MAX_TOOL_ROUNDS = 10;
const TURN_DEADLINE_MS_DEFAULT = Number(process.env.LLM_TIMEOUT_MS) || 120_000;

/**
 * Resolve the system prompt for a user. Returns the saved row if the
 * user customized it; otherwise returns the hardcoded SYSTEM_PROMPT
 * const. Never throws — a DB hiccup falls back to the default so the
 * chat pipeline never blocks on a settings lookup.
 */
function resolveSystemPrompt(userId) {
  if (!userId || typeof userId !== "number") return SYSTEM_PROMPT;
  try {
    const row = db
      .prepare("SELECT system_prompt FROM user_settings WHERE user_id = ?")
      .get(userId);
    const text = row?.system_prompt?.trim();
    return text && text.length > 0 ? text : SYSTEM_PROMPT;
  } catch {
    return SYSTEM_PROMPT;
  }
}

/**
 * Run an LLM turn. Returns immediately with a controller; the actual
 * loop runs in the background and emits events via `onEvent`.
 */
export function runLLM(prompt, opts = {}, onEvent) {
  const startedAt = Date.now();
  const modelName = opts.model || process.env.LLM_DEFAULT_MODEL || "workspace";
  const cwd = opts.cwd || process.cwd();
  // Per-project opt-outs: a disabled skill name is invisible to both
  // Skill.list and Skill.read. Snapshot once at turn start so a model
  // that re-lists mid-conversation can't see different content.
  const disabledSkills = Array.isArray(opts.disabledSkills) ? opts.disabledSkills : [];
  // Build the initial messages array. Vision recall across turns goes via
  // opts.history — each entry is either a plain string content or an
  // array of content parts (text + image_url). Caller is responsible for
  // trimming to the model context window.
  const history = Array.isArray(opts.history) ? opts.history : [];
  // Per-user prompt override (set via /api/auth/system-prompt). NULL/empty
  // falls back to the hardcoded SYSTEM_PROMPT const so behavior for
  // uncustomized users is bit-for-bit identical to before.
  const systemPrompt = resolveSystemPrompt(opts.userId);
  // Per-user memory facts appended below the persona/system block as a
  // second <system> section. Embed-mode calls pass userId=null so the
  // block is skipped automatically — platform user facts don't leak into
  // a tenant's chatbot context. DB hiccup returns '' silently.
  const memoryBlock = renderMemoryFactsBlock(opts.userId);
  // Per-project memory facts (Phase 5) — pre-resolved by the route
  // handler so the runner stays DB-free at chat time. Empty string
  // when the session has no project or the project has no facts;
  // reducer filter omits the section from the prompt entirely.
  const projectMemoryBlock = opts.projectMemoryBlock || "";
  // Project instructions (Opsi A) — projects.instructions lifted out of
  // the user-prompt prefix and injected here as a <system> block. Resolved
  // by the route handler; empty string when no project or no instructions.
  const projectInstructionsBlock = opts.projectInstructionsBlock || "";
  // Cross-session recall (Phase 3): top-3 snippets from past chats
  // semantically relevant to the current prompt. runLLM is synchronous
  // (returns a controller immediately), so we don't await here — the
  // IIFE awaits below before constructing the messages array. We
  // resolve into a shared mutable string the IIFE fills in. While the
  // recall is in flight (usually <50ms with the LRU embedder cache)
  // the IIFE still emits `init` and starts the round, so the user
  // sees no perceptible delay.
  const blocks = { recalled: "" };
  // Order: persona → user facts → project facts → project instructions
  // → recalled → session summary. Stable per-user prefix (persona +
  // user facts), stable per-project middle (project facts +
  // instructions), ephemeral tail (recall + summary). The recall
  // block starts as '' and is filled in by the IIFE below after the
  // async rag.query resolves. The IIFE waits for it before firing
  // the chat-completions request. The session summary is synchronous
  // (DB read) so it slots in immediately.
  const summaryBlock = opts.sessionId
    ? renderSessionSummaryBlock(opts.sessionId)
    : "";
  const fullSystemPrompt = (b) =>
    [memoryBlock, projectMemoryBlock, projectInstructionsBlock, b, summaryBlock]
      .filter(Boolean)
      .reduce((acc, block) => acc + "\n\n" + block, systemPrompt);
  const messagesRef = {
    systemContent: fullSystemPrompt(""),
    history,
    userContent:
      Array.isArray(opts.images) && opts.images.length > 0
        ? prompt
          ? [{ type: "text", text: prompt }, ...opts.images]
          : [{ type: "text", text: "(attached image)" }, ...opts.images]
        : (prompt || ""),
  };
  const turnDeadline = opts.turnDeadlineMs ?? TURN_DEADLINE_MS_DEFAULT;
  const sessionId = opts.sessionId || cryptoRandomId();

  // Emit init synchronously so the controller can be returned to
  // server.js without it having to await anything. server.js already
  // wraps onEvent callbacks, so a synchronous emit before returning is
  // safe.
  onEvent({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    model: modelName,
    tools: TOOLS.map((t) => t.function.name),
  });

  const proc = new EventEmitter();
  let aborted = false;

  proc.on("close", () => { /* server.js listens for this; no payload needed */ });

  // Kick off the background loop.
  (async () => {
    // Cross-session recall: resolve the recall block before constructing
    // messages so the first turn includes the snippets. rag.query is
    // usually <50ms with the LRU embedder cache; first-call cold embed
    // can be slower but the chat-init event has already been emitted
    // so the user sees no delay.
    if (opts.userId) {
      try {
        blocks.recalled = await renderRecalledContextBlock(
          opts.userId,
          prompt,
          opts.sessionId || null
        );
        messagesRef.systemContent = fullSystemPrompt(blocks.recalled);
      } catch {
        blocks.recalled = "";
        messagesRef.systemContent = fullSystemPrompt("");
      }
    }

    const messages = [
      { role: "system", content: messagesRef.systemContent },
      ...messagesRef.history,
      { role: "user", content: messagesRef.userContent },
    ];

    // Some upstream gateways (e.g. private combos that route to a
    // model without function-calling support) reject `tools` with a
    // 400. When that happens on the first turn, silently retry once
    // without the tools schema so the conversation still produces an
    // answer. Subsequent turns keep the same mode to avoid ping-pong.
    // The caller can also force tools off (e.g. when the user sends only
    // attachments with no text — leaving tools on tempts the model into
    // exploring an empty working directory instead of just looking at
    // the image it was handed).
    let toolsEnabled = opts.toolsEnabled !== false;

    const totals = { input_tokens: 0, output_tokens: 0 };

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (aborted) return emitResult({ is_error: false });
        if (Date.now() - startedAt > turnDeadline) {
          onEvent({ type: "stderr", text: `turn deadline ${turnDeadline}ms exceeded\n` });
          return emitResult({ is_error: true, error: "turn deadline exceeded" });
        }

        let assistantTextThisRound = "";
        /** @type {Array<{id:string,name:string,arguments:string}>} */
        let toolCalls = [];
        let usageThisRound = null;

        // Transient rate-limit (HTTP 429) — short backoff then retry the
        // same request up to twice before giving up. Keeps the chat from
        // failing on a single over-budget second.
        let sse = null;
        for (let retry = 0; retry < 3; retry++) {
          sse = await fetchChatCompletion({
            model: modelName,
            messages,
            includeTools: toolsEnabled,
            embedTools: opts.embedTools,
          });
          if (sse.status !== 429) break;
          const waitMs = 800 * (retry + 1);
          try { await sse.text(); } catch {}
          onEvent({ type: "stderr", text: `LLM rate-limited (429), retrying in ${waitMs}ms\n` });
          await new Promise((r) => setTimeout(r, waitMs));
        }
        if (!sse.ok) {
          const errBody = await sse.text().catch(() => "");
          // If tools caused the 400 and we haven't degraded yet, fall
          // back to text-only and inform the operator via stderr.
          if (sse.status === 400 && toolsEnabled) {
            toolsEnabled = false;
            onEvent({ type: "stderr", text: "model rejected tools payload — retrying without tools\n" });
            continue;
          }
          onEvent({ type: "stderr", text: `LLM HTTP ${sse.status}: ${errBody.slice(0, 400)}\n` });
          return emitResult({ is_error: true, error: `LLM HTTP ${sse.status}` });
        }
        if (!sse.body) {
          onEvent({ type: "stderr", text: "LLM response had no body\n" });
          return emitResult({ is_error: true, error: "empty response body" });
        }

        const reader = sse.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        let sawAny = false;

        try {
          let frameCount = 0;
          while (true) {
            if (aborted) break;
            const { value, done } = await reader.read();
            if (done) break;
            sawAny = true;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              frameCount++;
              for (const payload of parseSseFrame(frame)) {
                if (payload === "[DONE]") continue;
                let obj;
                try { obj = JSON.parse(payload); } catch (e) {
                  // Forward the raw payload to stderr so the operator
                  // can see exactly what the upstream gateway sent
                  // when no content makes it into the UI. Limit
                  // length so a runaway log line doesn't blow up.
                  onEvent({ type: "stderr", text: `non-JSON SSE frame #${frameCount}: ${payload.slice(0, 200)}\n` });
                  continue;
                }
                const choice = obj?.choices?.[0];
                const delta = choice?.delta;
                // Two payloads are common in dev gateways: SSE
                // frames and a non-stream JSON body when the
                // gateway decides streaming isn't worth it. Handle
                // the non-stream shape as a fallback so a single
                // JSON object with `choices[0].message.content`
                // becomes a text event too.
                const fallbackContent = !delta && !Array.isArray(delta?.tool_calls)
                  ? choice?.message?.content
                  : null;
                if (delta?.content) {
                  assistantTextThisRound += delta.content;
                  onEvent({ type: "text", text: delta.content });
                } else if (fallbackContent) {
                  assistantTextThisRound += fallbackContent;
                  onEvent({ type: "text", text: fallbackContent });
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    if (tc.id) {
                      let slot = toolCalls.find((t) => t.id === tc.id);
                      if (!slot) {
                        slot = { id: tc.id, name: tc.function?.name ?? "", arguments: "" };
                        toolCalls.push(slot);
                      }
                      if (tc.function?.name) slot.name = tc.function.name;
                      if (typeof tc.function?.arguments === "string") {
                        slot.arguments += tc.function.arguments;
                      }
                    }
                  }
                }
                if (obj?.usage) usageThisRound = obj.usage;
              }
            }
            if (frameCount === 0 && buf.length > 256) {
              // The body isn't using SSE framing at all — it's a
              // single JSON object. Parse it as one and bail.
              try {
                const obj = JSON.parse(buf.trim());
                const choice = obj?.choices?.[0];
                const content = choice?.message?.content;
                if (content) {
                  assistantTextThisRound += content;
                  onEvent({ type: "text", text: content });
                  sawAny = true;
                  // Cancel the read loop by jumping to the end.
                  try { await reader.cancel(); } catch { /* ignore */ }
                  break;
                }
              } catch { /* not JSON either */ }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }

        if (aborted) return emitResult({ is_error: false });
        if (!sawAny) {
          onEvent({ type: "stderr", text: "LLM returned an empty stream\n" });
          return emitResult({ is_error: true, error: "empty stream from LLM" });
        }

        if (usageThisRound) {
          totals.input_tokens += Number(usageThisRound.prompt_tokens ?? 0);
          totals.output_tokens += Number(usageThisRound.completion_tokens ?? 0);
        }

        // Persist assistant turn to the transcript. We push it before
        // the next model turn can be queued so the model sees its own
        // message on each iteration. Wire-format `tool_calls` is a
        // nested field on the assistant message in OpenAI's schema.
        messages.push({
          role: "assistant",
          content: assistantTextThisRound || null,
          tool_calls: toolCalls.length
            ? toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: t.arguments },
              }))
            : undefined,
        });

        if (!toolCalls.length) {
          // Final turn — emit result and close the controller.
          return emitResult({ is_error: false });
        }

        // Each tool call gets executed locally and appended to the
        // transcript as a 'tool' role message so the model can react.
        for (const tc of toolCalls) {
          if (aborted) break;
          let args = {};
          try {
            args = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch (e) {
            onEvent({ type: "stderr", text: `tool ${tc.name} had malformed JSON args\n` });
            pushToolResult(messages, tc.id, tc.name, { error: "malformed arguments" }, true);
            onEvent({ type: "tool_use", id: tc.id, name: tc.name, input: { _raw: tc.arguments } });
            onEvent({ type: "tool_result", tool_use_id: tc.id, content: "ERROR: malformed arguments", is_error: true });
            continue;
          }
          onEvent({ type: "tool_use", id: tc.id, name: tc.name, input: args });
          let r;
          // Skill.* and EmitArtifact are routed separately — they
          // don't touch the filesystem or run a deadline-bound process.
          if (tc.name === "Skill.list" || tc.name === "Skill.read") {
            r = await runSkillTool(tc.name, args, { disabled: disabledSkills });
          } else if (tc.name === "EmitArtifact") {
            // Embed mode gating: tenants with allow_artifact_generation=0
            // can't create artifacts. Refusing here (instead of silently
            // no-op'ing) gives the model a chance to revise its plan.
            if (opts.embedDispatch && opts.capability && opts.capability.allow_artifact_generation === false) {
              r = { error: "artifact generation is disabled for this tenant" };
              onEvent({ type: "stderr", text: `[embed] blocked EmitArtifact (allow_artifact_generation=0)\n` });
            } else {
              r = runEmitArtifact(args, onEvent);
            }
          } else if (typeof opts.embedDispatch === "function" && opts.embedTools?.some((t) => t.function?.name === tc.name)) {
            // Embed-mode tool (Kategori B): caller provides a dispatcher
            // that knows how to invoke the tool. We pass through args
            // plus a context object so the caller can write audit rows
            // with the message id.
            r = await opts.embedDispatch(tc.name, args, {
              tenant_id: opts.tenantId,
              external_user_id: opts.externalUserId,
              session_id: opts.sessionId,
            });
          } else if (tc.name === "Bash" && opts.embedDispatch && opts.capability && opts.capability.allow_bash === false) {
            // Embed mode bash gating: tenants with allow_bash=0 can't
            // shell out. This is the common case — embed tenants run
            // an HTTP chatbot, not a coding agent.
            r = { error: "bash is disabled for this tenant" };
            onEvent({ type: "stderr", text: `[embed] blocked Bash (allow_bash=0)\n` });
          } else {
            r = await runTool(tc.name, args, {
              cwd,
              deadlineMs: args.deadline_ms || DEFAULT_TOOL_DEADLINE_MS,
              // Embed tenants with allow_bash=true still get network
              // egress blocked — the embed threat model is "model may
              // run shell but cannot phone home to credential vaults
              // or other tenants' saas-app endpoints." A future
              // tenant config flag can opt-in to a curated allowlist.
              noNetworkEgress: !!opts.embedDispatch,
            });
          }
          const content = r.error
            ? { error: r.error }
            : (r.text ?? "");
          const text = truncate(String(typeof content === "string" ? content : JSON.stringify(content)), MAX_TOOL_RESULT_BYTES);
          onEvent({ type: "tool_result", tool_use_id: tc.id, content: text, is_error: !!r.error });
          pushToolResult(messages, tc.id, tc.name, text, !!r.error);
        }
        // Loop continues to next round.
      }
      onEvent({ type: "stderr", text: "max tool-call rounds reached\n" });
      return emitResult({ is_error: true, error: "max rounds" });
    } catch (e) {
      onEvent({ type: "stderr", text: `LLM loop failed: ${e?.stack || e}\n` });
      emitResult({ is_error: true, error: e?.message || String(e) });
    }

    function emitResult({ is_error, error }) {
      onEvent({
        type: "result",
        is_error: !!is_error,
        result: error,
        duration_ms: Date.now() - startedAt,
        total_cost_usd: 0,
        usage: totals,
      });
      // The server.js on('close') handler persists the assistant
      // message — fire close on a microtask so the result event
      // reaches the client first.
      setImmediate(() => proc.emit("close", is_error ? -1 : 0));
    }
  })();

  return {
    kill: () => { aborted = true; },
    proc,
  };
}

function pushToolResult(messages, id, name, content, isError) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  messages.push({
    role: "tool",
    tool_call_id: id,
    name,
    content: isError ? `ERROR: ${text}` : text,
  });
}

// Handle the EmitArtifact tool call. The model provides the full
// content explicitly (no fence parsing, no phrase guessing). Validate
// the payload, hand it off to server.js via the `tool_artifact` event
// so the same dedup + persistence path the fence-detector uses runs
// uniformly, and return a short confirmation string back to the
// model so it knows the call succeeded.
function runEmitArtifact(args, emit) {
  const type = ["html", "react", "svg", "markdown", "code"].includes(args.type)
    ? args.type
    : "code";
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title.trim().slice(0, 80)
    : "Artifact";
  const language = typeof args.language === "string" && args.language.trim()
    ? args.language.trim().slice(0, 32)
    : null;
  const content = typeof args.content === "string" ? args.content : "";
  if (!content) return { error: "content is required" };
  if (content.length > 256 * 1024) {
    return { error: "artifact too large (>256KB); chunk or save to disk via Write instead" };
  }
  const contentHash = hashArtifact(type, content);
  // Re-emit through the same channel as fence-detected artifacts so
  // server.js' existing handler at evt.type === 'tool_artifact' runs
  // the same dedup + INSERT + socket emit path. The frontend sees an
  // identical 'artifact' event either way.
  emit({ type: "tool_artifact", artifact: {
    type,
    language,
    title,
    content,
    content_hash: contentHash,
    source: "tool",
  } });
  return { text: `emitted artifact "${title}" (${type}, ${content.length} bytes)` };
}

async function fetchChatCompletion({ model, messages, includeTools = true, embedTools }) {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "";
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.2,
  };
  if (includeTools) {
    // Embed mode passes embedTools — Kategori B tools registered for
    // the tenant. Format matches the static TOOLS array (OpenAI
    // function-calling shape: { type: 'function', function: { name,
    // description, parameters } }). Skill tools still apply globally;
    // we never replace them. embedTools is destructured from the args
    // (not read from `opts` like the rest of runLLM) because this
    // function is module-scope and `opts` isn't in scope here.
    const staticTools = Array.isArray(embedTools) && embedTools.length > 0
      ? embedTools
      : TOOLS;
    body.tools = [...staticTools, ...skillTools];
    body.tool_choice = "auto";
  }
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
    },
    body: JSON.stringify(body),
  });
}

function parseSseFrame(frame) {
  const out = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    out.push(line.slice(5).trimStart());
  }
  return out;
}

function truncate(s, max) {
  if (typeof s !== "string") s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
}

function cryptoRandomId() {
  try {
    // eslint-disable-next-line no-undef
    return require("node:crypto").randomUUID();
  } catch {
    return "run-" + Math.random().toString(36).slice(2, 10);
  }
}
