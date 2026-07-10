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

const SYSTEM_PROMPT = `You are a coding assistant. You have read/write
access to a working directory via the provided tools. Prefer small,
focused changes. Always read a file before editing it unless the user
provided the full contents verbatim. Keep prose concise.

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
];

const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const DEFAULT_TOOL_DEADLINE_MS = 30_000;
const MAX_TOOL_ROUNDS = 10;
const TURN_DEADLINE_MS_DEFAULT = Number(process.env.LLM_TIMEOUT_MS) || 120_000;

/**
 * Run an LLM turn. Returns immediately with a controller; the actual
 * loop runs in the background and emits events via `onEvent`.
 */
export function runLLM(prompt, opts = {}, onEvent) {
  const startedAt = Date.now();
  const modelName = opts.model || process.env.LLM_DEFAULT_MODEL || "workspace";
  const cwd = opts.cwd || process.cwd();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
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

        const sse = await fetchChatCompletion({ model: modelName, messages });
        if (!sse.ok) {
          const errBody = await sse.text().catch(() => "");
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
              for (const payload of parseSseFrame(frame)) {
                if (payload === "[DONE]") continue;
                let obj;
                try { obj = JSON.parse(payload); } catch { continue; }
                const choice = obj?.choices?.[0];
                const delta = choice?.delta;
                if (delta?.content) {
                  assistantTextThisRound += delta.content;
                  onEvent({ type: "text", text: delta.content });
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    // Each tool_call arrives as a sequence of deltas:
                    // the first carries id+name, subsequent carry only
                    // fragments of the arguments JSON. We accumulate
                    // in place.
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
          const r = await runTool(tc.name, args, {
            cwd,
            deadlineMs: args.deadline_ms || DEFAULT_TOOL_DEADLINE_MS,
          });
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

async function fetchChatCompletion({ model, messages }) {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || "";
  const url = `${baseUrl}/chat/completions`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      stream: true,
      temperature: 0.2,
    }),
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
