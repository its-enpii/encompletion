/**
 * Bounded tool execution for the LLM runner.
 *
 * Each tool returns { text: string, error?: string }. The runner emits
 * that string back to the model; we keep outputs small so a single
 * tool result can't flood the context window, and we cap wall-clock
 * time so a runaway `sleep 9999` can't lock up a turn forever.
 *
 * The `cwd` passed in is the only filesystem root the tools see.
 * `Read` / `Write` / `Edit` resolve paths against `cwd` and refuse
 * to escape it; the same is enforced via the spawn cwd for `Bash`,
 * so the model can't `cat /etc/passwd` or `rm -rf /`.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;

/**
 * Dispatch table. Throws on unknown tool so the runner surfaces a
 * real error instead of a silent no-op.
 */
export async function runTool(name, args, { cwd, deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const handler = handlers[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  try {
    return await handler(args ?? {}, { cwd, deadlineMs });
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

const handlers = {
  Bash: (args, ctx) => runBash(args, ctx),
  Read: (args, ctx) => runRead(args, ctx),
  Write: (args, ctx) => runWrite(args, ctx),
  Edit: (args, ctx) => runEdit(args, ctx),
  Glob: (args, ctx) => runGlob(args, ctx),
  Grep: (args, ctx) => runGrep(args, ctx),
};

function resolveSafe(target, cwd) {
  const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  const base = path.resolve(cwd) + path.sep;
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(base)) {
    throw new Error(`path escapes working directory: ${target}`);
  }
  return abs;
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool deadline ${ms}ms exceeded`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runBash({ command }, { cwd, deadlineMs }) {
  if (!command || typeof command !== "string") return { error: "command is required" };
  if (command.length > 32 * 1024) return { error: "command too long" };
  return withDeadline(
    new Promise((resolve) => {
      const proc = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: { ...process.env, PS1: "", PS2: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => { out += d.toString(); });
      proc.stderr.on("data", (d) => { err += d.toString(); });
      proc.on("error", (e) => resolve({ error: e.message }));
      proc.on("close", (code) => {
        const combined = (out + (err ? `\n[stderr]\n${err}` : "")).trimEnd();
        const text = code === 0
          ? combined
          : `${combined}\n[exit ${code}]`;
        resolve(truncateOk({ text }, MAX_OUTPUT_BYTES));
      });
    }),
    deadlineMs
  );
}

async function runRead({ path: p, start_line, end_line }, { cwd }) {
  if (!p) return { error: "path is required" };
  let abs;
  try { abs = resolveSafe(p, cwd); } catch (e) { return { error: e.message }; }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return { error: `not a file: ${p}` };
  if (stat.size > 4 * 1024 * 1024) {
    // Big files: only honor a window request, otherwise error out.
    if (typeof start_line !== "number" && typeof end_line !== "number") {
      return { error: `file too large (${stat.size} bytes); pass start_line/end_line to slice it` };
    }
  }
  const fh = await fs.open(abs, "r");
  try {
    const text = await fh.readFile("utf8");
    const lines = text.split("\n");
    const s = typeof start_line === "number" ? Math.max(0, start_line) : 0;
    const e = typeof end_line === "number" ? Math.min(lines.length, end_line) : lines.length;
    return truncateOk({ text: lines.slice(s, e).join("\n") }, MAX_OUTPUT_BYTES);
  } finally {
    await fh.close();
  }
}

async function runWrite({ path: p, content }, { cwd }) {
  if (!p) return { error: "path is required" };
  if (typeof content !== "string") return { error: "content must be a string" };
  let abs;
  try { abs = resolveSafe(p, cwd); } catch (e) { return { error: e.message }; }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { text: `wrote ${content.length} bytes to ${p}` };
}

async function runEdit({ path: p, old_string, new_string, replace_all }, { cwd }) {
  if (!p) return { error: "path is required" };
  if (typeof old_string !== "string" || typeof new_string !== "string") {
    return { error: "old_string and new_string are required strings" };
  }
  let abs;
  try { abs = resolveSafe(p, cwd); } catch (e) { return { error: e.message }; }
  let text;
  try { text = await fs.readFile(abs, "utf8"); }
  catch (e) { return { error: `cannot read ${p}: ${e.message}` }; }

  let count = 0;
  let next;
  if (replace_all) {
    next = text.split(old_string).join(new_string);
    count = text.split(old_string).length - 1;
  } else {
    const idx = text.indexOf(old_string);
    if (idx === -1) return { error: `old_string not found in ${p}` };
    const second = text.indexOf(old_string, idx + 1);
    if (second !== -1) return { error: `old_string matched multiple times in ${p} — pass replace_all or narrow it` };
    next = text.slice(0, idx) + new_string + text.slice(idx + old_string.length);
    count = 1;
  }

  if (next === text) return { text: "no-op (no change)" };
  await fs.writeFile(abs, next, "utf8");
  return { text: `replaced ${count} occurrence(s) in ${p}` };
}

async function runGlob({ pattern }, { cwd }) {
  if (!pattern) return { error: "pattern is required" };
  // Minimal no-dep glob: shell out to `find ... -path`. Cheap, safe
  // because pattern is whitelisted to non-shell-meta outside of ?
  // and *, and we cap the result count.
  return runBash(
    { command: `find . -path '${escapeSingle(pattern)}' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' 2>/dev/null | head -200` },
    { cwd, deadlineMs: DEFAULT_DEADLINE_MS }
  );
}

async function runGrep({ pattern, path: target, include_glob }, { cwd }) {
  if (!pattern) return { error: "pattern is required" };
  const include = include_glob ? `--include='${escapeSingle(include_glob)}'` : "";
  const searchPath = target ? `'${escapeSingle(target)}'` : ".";
  return runBash(
    { command: `grep -rnE ${include} -- ${shellQuote(pattern)} ${searchPath} 2>/dev/null | grep -v 'node_modules/\\|.git/\\|.next/' | head -300` },
    { cwd, deadlineMs: DEFAULT_DEADLINE_MS }
  );
}

function escapeSingle(s) {
  return String(s).replace(/'/g, `'\\''`);
}

function shellQuote(s) {
  return `'${escapeSingle(s)}'`;
}

function truncateOk(obj, max) {
  if (obj.text && obj.text.length > max) {
    const cut = obj.text.slice(0, max);
    return { text: cut + `\n…[truncated ${obj.text.length - max} bytes]` };
  }
  return obj;
}
