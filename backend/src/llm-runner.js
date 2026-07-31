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
import { buildTodayContextBlock } from "./today-context.js";
import { buildXlsx, buildPdf, buildPptx, safeDocFileName } from "./document-writer.js";
import db from "./db/index.js";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

const LLM_STREAM_TIMEOUT_MS = Math.max(30_000, Number(process.env.LLM_STREAM_TIMEOUT_MS) || 120_000);

// Chat-web product (Claude/ChatGPT/Gemini style) — not a coding agent.
// File tools exist only as a workspace for drafting multi-file artifacts.
// Shell/Bash is not offered to the model.
const SYSTEM_PROMPT = `You are a helpful chat assistant in a web conversation UI
(like Claude, ChatGPT, or Gemini). Answer clearly. Prefer natural prose.
You are not a coding agent and you cannot run shell commands or operate a
developer terminal.

When the user wants a sizable deliverable (HTML page, React component, SVG,
markdown doc, config, script, table), publish it with EmitArtifact so it
opens in the artifact panel. Pass {type, title, language?, content}. Skip
EmitArtifact for short inline examples that only illustrate a sentence.
When you EmitArtifact, do not also paste the full content as a fenced code
block — describe what you published and let the panel show the body.

When the user wants a real downloadable spreadsheet, PDF, or PowerPoint,
use CreateDocument (format xlsx|pdf|pptx). Do not fake Office binaries as
markdown. For PDF text: instruct the model to rewrite into a clean, professional report
with natural headings, short sections, and flowing prose — never dump raw source
markdown or pipe tables. Use "# Heading", "## Section", "- bullet" only as structure.
Avoid fancy unicode; prefer plain ASCII.

Workspace tools (Read/Write/Edit/Glob/Grep) are only for drafting multi-file
artifacts inside the session workspace before publishing with EmitArtifact.
Do not treat the workspace as a project repo to "build" or "run". Prefer
EmitArtifact directly when a single file is enough.

Skill_list / Skill_read: if a skill matches the request, list then read it
and follow its procedure. For plans/roadmaps use skill "planning"; for PRDs
or product specs use skill "prd". Diagrams: put mermaid in fenced
\`\`\`mermaid blocks (chat and markdown artifacts render them).

Web research:
- WebSearch: open-ended questions, news, facts you may not know, "what's the
  latest…". Call it before guessing. Then WebFetch 1–2 best URLs if you need
  full page text. Cite sources with URLs in your reply.
- WebFetch: when the user already named a URL, or after WebSearch when a
  specific page must be read. Skip either tool if the user says not to look
  it up, or the answer is pure prior knowledge.

When you finish a turn, do not ask for the next task — wait for the user.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read a file from the session artifact workspace. Use while drafting " +
        "multi-file artifacts. Files larger than ~4MB require start_line/end_line.",
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
      description:
        "Write a file in the session artifact workspace (draft material for " +
        "artifacts). Not a project checkout — publish finished work via EmitArtifact.",
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
      description:
        "Search-and-replace in a workspace draft file. old_string must match " +
        "exactly once unless replace_all=true.",
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
      description: "List workspace draft files matching a glob pattern.",
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
      description: "Search workspace draft file contents with regex.",
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
      name: "WebSearch",
      description:
        "Search the public web and return top result titles, URLs, and " +
        "snippets. Use for open-ended research, current events, or facts " +
        "that may be outside training data. After searching, use WebFetch " +
        "on specific URLs when you need full page content. Always cite URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          max_results: {
            type: "integer",
            description: "How many results to return (1–10, default 5).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebFetch",
      description:
        "Fetch a public http(s) URL and return the body as text. HTML is " +
        "stripped to plain text. Use for pages, public APIs, or docs the user " +
        "asks about — or after WebSearch when a result needs a full read. " +
        "Private/loopback addresses are rejected.",
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
        "Publish a deliverable to the chat artifact panel (preview, copy, " +
        "save, render). Use for complete files, UI snippets, configs, docs. " +
        "Not for tiny one-liner examples that only illustrate prose. " +
        "For real .xlsx/.pdf/.pptx downloads use CreateDocument instead.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["html", "react", "svg", "markdown", "code"],
            description:
              "Render mode: html, react (JSX/TSX), svg, markdown, or code " +
              "(JSON/YAML/scripts/etc.).",
          },
          title: {
            type: "string",
            description: "Short card label (e.g. login.html). Under 80 chars.",
          },
          language: {
            type: "string",
            description: "Language id when type is code (e.g. python, json).",
          },
          content: {
            type: "string",
            description: "Full artifact body.",
          },
        },
        required: ["type", "title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "CreateDocument",
      description:
        "Create a downloadable binary document (xlsx, text PDF, or pptx) " +
        "and attach it to the chat as a file artifact. Prefer this over " +
        "markdown tables/lists when the user asks for Excel, PDF, or PowerPoint. " +
        'format MUST be exactly one of: "pdf", "xlsx", "pptx" (lowercase).',
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["xlsx", "pdf", "pptx"],
            description: 'Exact lowercase: "pdf" | "xlsx" | "pptx".',
          },
          title: {
            type: "string",
            description: "File title / download name (without path).",
          },
          sheets: {
            type: "array",
            description: "Required for xlsx. Each sheet has name + rows (2D array).",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                rows: {
                  type: "array",
                  items: { type: "array", items: {} },
                },
              },
              required: ["rows"],
            },
          },
          text: {
            type: "string",
            description: "Required for pdf if lines omitted. Full body text.",
          },
          lines: {
            type: "array",
            items: { type: "string" },
            description: "Optional for pdf: pre-split lines.",
          },
          slides: {
            type: "array",
            description:
              "Required for pptx. Each slide: title, bullets (string array), optional notes.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                body: { type: "string", description: "Alt to bullets: newline-separated text." },
                notes: { type: "string" },
              },
            },
          },
        },
        required: ["format", "title"],
      },
    },
  },
];

const MAX_TOOL_RESULT_BYTES = 64 * 1024;

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
  // Skill_list and Skill_read. Snapshot once at turn start so a model
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
  // Per-user memory facts appended below the system block. DB hiccup → ''.
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
  // Order: user facts → project facts → project instructions → recalled
  // → session summary. Recall block starts empty; IIFE fills it before
  // the first chat-completions request.
  const summaryBlock = opts.sessionId
    ? renderSessionSummaryBlock(opts.sessionId)
    : "";
  // Fresh clock each turn so "sekarang" / relative dates stay accurate.
  const nowBlock = buildTodayContextBlock();
  const fullSystemPrompt = (b) =>
    [nowBlock, memoryBlock, projectMemoryBlock, projectInstructionsBlock, b, summaryBlock]
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
  let activeController = null;
  let activeTimer = null;

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
      // Cap tool rounds so a confused model (retry CreateDocument forever)
      // cannot hang the run. Client kill still aborts earlier.
      const MAX_TOOL_ROUNDS = Math.max(1, Number(process.env.LLM_MAX_TOOL_ROUNDS) || 12);
      let toolRound = 0;
      while (true) {
        if (aborted) return emitResult({ is_error: false });

        let assistantTextThisRound = "";
        /** @type {Array<{id:string,name:string,arguments:string}>} */
        let toolCalls = [];
        let usageThisRound = null;

        // Transient rate-limit (HTTP 429) — short backoff then retry the
        // same request up to twice before giving up. Keeps the chat from
        // failing on a single over-budget second.
        let sse = null;
        for (let retry = 0; retry < 3; retry++) {
          activeController = new AbortController();
          activeTimer = setTimeout(() => activeController.abort(new Error("LLM upstream stream timeout")), LLM_STREAM_TIMEOUT_MS);
          sse = await fetchChatCompletion({
            model: modelName,
            messages,
            includeTools: toolsEnabled,
            signal: activeController.signal,
          });
          if (sse.status !== 429) break;
          clearTimeout(activeTimer);
          const waitMs = 800 * (retry + 1);
          try { await sse.text(); } catch {}
          onEvent({ type: "stderr", text: `LLM rate-limited (429), retrying in ${waitMs}ms\n` });
          await new Promise((r) => setTimeout(r, waitMs));
        }
        if (!sse.ok) {
          clearTimeout(activeTimer);
          activeController = null;
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
          clearTimeout(activeTimer);
          activeController = null;
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
                    // OpenAI streams tool_calls by index: first chunk has
                    // id+name, later chunks only {index, function:{arguments}}.
                    // Matching only on tc.id drops every argument delta.
                    let slot = null;
                    if (tc.id) slot = toolCalls.find((t) => t.id === tc.id);
                    if (!slot && typeof tc.index === "number") {
                      slot = toolCalls.find((t) => t.index === tc.index);
                    }
                    if (!slot) {
                      slot = {
                        id: tc.id || `call_${toolCalls.length}`,
                        index: typeof tc.index === "number" ? tc.index : toolCalls.length,
                        name: tc.function?.name ?? "",
                        arguments: "",
                      };
                      toolCalls.push(slot);
                    }
                    if (tc.id) slot.id = tc.id;
                    if (typeof tc.index === "number") slot.index = tc.index;
                    if (tc.function?.name) slot.name = tc.function.name;
                    const argPiece = tc.function?.arguments;
                    if (typeof argPiece === "string") slot.arguments += argPiece;
                    else if (argPiece && typeof argPiece === "object") {
                      // Some gateways send the full object once.
                      slot.arguments = JSON.stringify(argPiece);
                    }
                  }
                }
                // Non-delta tool_calls on the final message object (some
                // gateways only put tools there, never in deltas).
                const msgToolCalls = choice?.message?.tool_calls;
                if (Array.isArray(msgToolCalls) && msgToolCalls.length && !toolCalls.length) {
                  for (const tc of msgToolCalls) {
                    const args = tc.function?.arguments;
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      index: typeof tc.index === "number" ? tc.index : toolCalls.length,
                      name: tc.function?.name ?? "",
                      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
                    });
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
                }
                const msgToolCalls = choice?.message?.tool_calls;
                if (Array.isArray(msgToolCalls)) {
                  for (const tc of msgToolCalls) {
                    const args = tc.function?.arguments;
                    toolCalls.push({
                      id: tc.id || `call_${toolCalls.length}`,
                      index: typeof tc.index === "number" ? tc.index : toolCalls.length,
                      name: tc.function?.name ?? "",
                      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
                    });
                    sawAny = true;
                  }
                }
                if (content || (msgToolCalls && msgToolCalls.length)) {
                  try { await reader.cancel(); } catch { /* ignore */ }
                  break;
                }
              } catch { /* not JSON either */ }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
          clearTimeout(activeTimer);
          activeController = null;
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

        toolRound += 1;
        if (toolRound > MAX_TOOL_ROUNDS) {
          onEvent({
            type: "stderr",
            text: `tool loop capped at ${MAX_TOOL_ROUNDS} rounds — stopping\n`,
          });
          onEvent({
            type: "text",
            text: `\n\n(Berhenti: terlalu banyak langkah tool berulang. Coba minta ulang dengan instruksi lebih spesifik.)`,
          });
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
          // Skill_*, EmitArtifact, CreateDocument are routed separately.
          if (tc.name === "Skill_list" || tc.name === "Skill_read") {
            r = await runSkillTool(tc.name, args, { disabled: disabledSkills });
          } else if (tc.name === "EmitArtifact") {
            r = runEmitArtifact(args, onEvent);
          } else if (tc.name === "CreateDocument") {
            // Operator log only — don't use stderr (FE surfaces stderr as error banner).
            process.stderr.write(
              `[CreateDocument] raw_args=${JSON.stringify(tc.arguments || "").slice(0, 300)} parsed=${JSON.stringify(args).slice(0, 300)}\n`
            );
            r = await runCreateDocument(args, onEvent, { cwd, sessionId: opts.sessionId });
            if (r?.error) {
              process.stderr.write(`[CreateDocument] failed: ${r.error}\n`);
            }
          } else if (tc.name === "Bash") {
            // Chat product, not coding agent — Bash never on tool list.
            r = { error: "bash is disabled (chat product, not a coding agent)" };
            onEvent({ type: "stderr", text: `[tools] blocked Bash\n` });
          } else {
            r = await runTool(tc.name, args, { cwd });
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
    kill: () => { aborted = true; activeController?.abort(new Error("run stopped")); },
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

async function runCreateDocument(rawArgs, emit, { cwd, sessionId } = {}) {
  // Unwrap common nesting mistakes: { parameters: {...} }, { input: {...} },
  // or a JSON string body.
  let args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  if (typeof rawArgs === "string") {
    try { args = JSON.parse(rawArgs); } catch { args = {}; }
  }
  if (args.parameters && typeof args.parameters === "object") args = { ...args.parameters, ...args };
  if (args.input && typeof args.input === "object" && !args.format && !args.text && !args.sheets) {
    args = { ...args.input, ...args };
  }
  if (args.arguments && typeof args.arguments === "object") {
    args = { ...args.arguments, ...args };
  }

  // Models often send "PDF", "Pdf", "application/pdf", or bury the type in
  // the title ("report.pdf"). Normalize aggressively so a single wrong case
  // doesn't kick off a retry loop.
  function resolveFormat(raw, titleHint) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (!s && !titleHint) return null;
    if (s === "pdf" || s === "application/pdf" || s.endsWith("/pdf")) return "pdf";
    if (s === "xlsx" || s === "xls" || s === "excel" || s === "spreadsheet"
      || s.includes("spreadsheetml") || s === "application/vnd.ms-excel") return "xlsx";
    if (s === "pptx" || s === "ppt" || s === "powerpoint" || s === "presentation"
      || s.includes("presentationml")) return "pptx";
    const t = String(titleHint ?? "").trim().toLowerCase();
    if (t.endsWith(".pdf")) return "pdf";
    if (t.endsWith(".xlsx") || t.endsWith(".xls")) return "xlsx";
    if (t.endsWith(".pptx") || t.endsWith(".ppt")) return "pptx";
    if (/\bpdf\b/.test(s) || /\bpdf\b/.test(t)) return "pdf";
    if (/\b(xlsx|excel)\b/.test(s) || /\b(xlsx|excel)\b/.test(t)) return "xlsx";
    if (/\b(pptx|powerpoint)\b/.test(s) || /\b(pptx|powerpoint)\b/.test(t)) return "pptx";
    return null;
  }
  const titleRaw = typeof args.title === "string" ? args.title
    : typeof args.name === "string" ? args.name
    : typeof args.filename === "string" ? args.filename
    : typeof args.file_name === "string" ? args.file_name
    : "";

  function inferFromPayload(a) {
    if (Array.isArray(a?.sheets) && a.sheets.length) return "xlsx";
    if (Array.isArray(a?.slides) && a.slides.length) return "pptx";
    if (typeof a?.text === "string" && a.text.trim()) return "pdf";
    if (Array.isArray(a?.lines) && a.lines.length) return "pdf";
    if (typeof a?.content === "string" && a.content.trim()) return "pdf";
    if (typeof a?.body === "string" && a.body.trim()) return "pdf";
    if (typeof a?.markdown === "string" && a.markdown.trim()) return "pdf";
    return null;
  }

  // Default: if still unknown but title/name suggests a doc, assume pdf.
  // Empty body will still fail with a clear "needs text" error below.
  const format = resolveFormat(args.format, titleRaw)
    || resolveFormat(args.type, titleRaw)
    || resolveFormat(args.file_type, titleRaw)
    || resolveFormat(args.kind, titleRaw)
    || resolveFormat(args.output, titleRaw)
    || inferFromPayload(args)
    || (titleRaw ? "pdf" : null);

  if (!format) {
    return {
      error:
        'CreateDocument needs format + body. Example: '
        + '{"format":"pdf","title":"Guide","text":"...full document text..."}. '
        + 'For excel use sheets; for pptx use slides. Do not call with empty args.',
    };
  }
  const title = titleRaw.trim()
    ? titleRaw.trim().slice(0, 80)
    : (format === "xlsx" ? "spreadsheet" : format === "pptx" ? "presentation" : "document");

  // Accept common aliases models invent for body content.
  const pdfText = typeof args.text === "string" ? args.text
    : typeof args.content === "string" ? args.content
    : typeof args.body === "string" ? args.body
    : typeof args.markdown === "string" ? args.markdown
    : typeof args.html === "string" ? args.html
    : undefined;
  const pdfLines = Array.isArray(args.lines) ? args.lines
    : Array.isArray(args.paragraphs) ? args.paragraphs
    : Array.isArray(args.sections) ? args.sections.map((s) =>
        typeof s === "string" ? s : [s?.title, s?.text, s?.body].filter(Boolean).join("\n")
      )
    : undefined;

  let buf;
  try {
    if (format === "xlsx") {
      if (!Array.isArray(args.sheets) || !args.sheets.length) {
        return { error: 'xlsx requires sheets: [{ name, rows: [[...]] }]' };
      }
      buf = buildXlsx({ sheets: args.sheets });
    } else if (format === "pptx") {
      if (!Array.isArray(args.slides) || !args.slides.length) {
        return { error: 'pptx requires slides: [{ title, bullets }]' };
      }
      buf = await buildPptx({ title, slides: args.slides });
    } else {
      if (!pdfText && (!pdfLines || !pdfLines.length)) {
        return { error: 'pdf requires text or lines (non-empty body)' };
      }
      buf = await buildPdf({ title, text: pdfText, lines: pdfLines });
    }
  } catch (e) {
    return { error: e?.message || String(e) };
  }
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { error: "empty document" };
  }
  if (buf.length > 20 * 1024 * 1024) {
    return { error: "document too large (>20MB)" };
  }

  const storageRoot = process.env.STORAGE_PATH
    ? path.resolve(process.cwd(), process.env.STORAGE_PATH)
    : path.resolve(process.cwd(), "storage/attachments");
  const docsDir = path.join(storageRoot, "docs", String(sessionId || "anon"));
  await fsp.mkdir(docsDir, { recursive: true });
  const fileName = safeDocFileName(title, format);
  const unique = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${fileName}`;
  const abs = path.join(docsDir, unique);
  await fsp.writeFile(abs, buf);

  // Also drop a copy in session workdir when available so Read/Glob can see it.
  if (cwd) {
    try {
      await fsp.writeFile(path.join(cwd, fileName), buf);
    } catch { /* ignore workdir copy failures */ }
  }

  const mime =
    format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : format === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "application/pdf";
  const rel = path.relative(storageRoot, abs).split(path.sep).join("/");
  const contentHash = hashArtifact("file", rel + "|" + buf.length);
  const preview =
    format === "xlsx" ? `Excel workbook (${buf.length} bytes)`
    : format === "pptx" ? `PowerPoint deck (${buf.length} bytes)`
    : `PDF document (${buf.length} bytes)`;

  emit({ type: "tool_artifact", artifact: {
    type: "file",
    language: format,
    title: fileName,
    content: preview,
    content_hash: contentHash,
    file_path: rel,
    mime_type: mime,
    file_size: buf.length,
    source: "tool",
  } });
  return {
    text: `created ${format.toUpperCase()} "${fileName}" (${buf.length} bytes). User can download from the artifact card.`,
  };
}

async function fetchChatCompletion({ model, messages, includeTools = true, signal }) {
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
    body.tools = [...TOOLS, ...skillTools];
    body.tool_choice = "auto";
  }
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
    },
    body: JSON.stringify(body),
    signal,
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