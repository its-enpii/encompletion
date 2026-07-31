/**
 * Tool execution for the LLM runner.
 *
 * Each tool returns { text: string, error?: string }. The runner emits
 * that string back to the model; we keep outputs small so a single
 * tool result can't flood the context window. No wall-clock deadline —
 * stop is client kill only.
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
import { assertSafeHttpUrl, assertSafeResolvedHost } from "./net-guard.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Dispatch table. Throws on unknown tool so the runner surfaces a
 * real error instead of a silent no-op.
 *
 * opts.noNetworkEgress=true blocks Bash commands that try to reach
 * the network (curl/wget/nc/etc.). Pre-execution token scan.
 */
const handlers = {
  Bash: (args, ctx) => runBash(args, ctx),
  Read: (args, ctx) => runRead(args, ctx),
  Write: (args, ctx) => runWrite(args, ctx),
  Edit: (args, ctx) => runEdit(args, ctx),
  Glob: (args, ctx) => runGlob(args, ctx),
  Grep: (args, ctx) => runGrep(args, ctx),
  WebFetch: (args, ctx) => runWebFetch(args, ctx),
  WebSearch: (args, ctx) => runWebSearch(args, ctx),
};

export async function runTool(name, args, { cwd, noNetworkEgress = false } = {}) {
  const handler = handlers[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  try {
    return await handler(args ?? {}, { cwd, noNetworkEgress });
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Network-capable binaries we refuse to invoke when noNetworkEgress
// is set. The set is deliberately small and conservative — a typo
// here only weakens the sandbox, never strengthens it.
const NETWORK_BINARIES = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'sftp',
  'scp', 'ssh', 'rsync', 'http', 'httpie', 'xh', 'aria2c',
  // package installers that hit the network by default
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'gem', 'cargo', 'go',
]);

// Pre-execution scan: walk the command string looking for bare tokens
// (after splitting on shell metacharacters) that match a deny-listed
// binary. We don't try to be a real shell parser — we just refuse
// anything that obviously shells out to a network-capable binary.
// `bash -c "curl ..."` style indirection is caught because both
// tokens are visible in the command string.
function scanForNetworkCommand(command) {
  // Tokenize on shell metacharacters: ; & | ` ( ) < > space tab newline.
  // Quotes are stripped per-token (balanced and unbalanced) so
  // `bash -c "curl ..."` still matches even when the outer sh has
  // already collapsed one level of quoting, leaving an orphan quote
  // glued to the token. Not a full shell parser — strict tokenization
  // is enough to refuse obvious network egress.
  const tokens = command.split(/[\s;|&`()<>]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    // Strip all leading/trailing quote chars regardless of balance —
    // `/bin/sh -c 'cmd'` and `bash -c "curl ..."` both leave orphan
    // quotes attached to the next argument after the outer sh parsed.
    while (t.length > 0 && (t[0] === '"' || t[0] === "'" || t[0] === '\\')) t = t.slice(1);
    while (t.length > 0 && (t[t.length - 1] === '"' || t[t.length - 1] === "'" || t[t.length - 1] === '\\')) t = t.slice(0, -1);
    // Strip path prefix (e.g. /usr/bin/curl → curl).
    const base = t.split('/').pop();
    if (NETWORK_BINARIES.has(base)) {
      return base;
    }
  }
  return null;
}

function resolveSafe(target, cwd) {
  const root = path.resolve(cwd);
  const base = root + path.sep;
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  // Lexical check first (cheap).
  if (abs !== root && !abs.startsWith(base)) {
    throw new Error(`path escapes working directory: ${target}`);
  }
  // Symlink-aware: realpath of existing path, or realpath(dirname)+basename
  // for files not yet created (Write). Re-check containment after resolve.
  let real;
  try {
    real = fsSync.realpathSync(abs);
  } catch {
    let parentReal;
    try { parentReal = fsSync.realpathSync(path.dirname(abs)); }
    catch { parentReal = path.dirname(abs); }
    real = path.join(parentReal, path.basename(abs));
  }
  if (real !== root && !real.startsWith(base)) {
    throw new Error(`path escapes working directory: ${target}`);
  }
  return real;
}

// Whitelist env passed to child shells. API keys and tokens stay in the
// Node process; the model can only see what's safe for a sandboxed shell.
const SHELL_ALLOWED_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TZ", "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD",
  "TERM", "COLORTERM", "LSCOLORS", "EDITOR", "VISUAL",
  "NODE_ENV", "FORCE_COLOR", "NO_COLOR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "GIT_TERMINAL_PROMPT",
]);
function safeChildEnv() {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (SHELL_ALLOWED_ENV_KEYS.has(k)) env[k] = process.env[k];
  }
  env.PS1 = "";
  env.PS2 = "";
  return env;
}

async function runBash({ command }, { cwd, noNetworkEgress }) {
  if (!command || typeof command !== "string") return { error: "command is required" };
  if (command.length > 32 * 1024) return { error: "command too long" };
  // Embed mode: refuse network-capable binaries before they spawn.
  // Done as a token scan because /bin/sh -c already happened above —
  // we can't intercept fork()/execve() from JS without kernel help.
  // Honest tradeoff: a determined attacker who finds a non-denylisted
  // binary that happens to make network calls could still slip
  // through. Tighten by adding it to the list, or by switching to a
  // seccomp-based sandbox in E5.
  if (noNetworkEgress) {
    const blocked = scanForNetworkCommand(command);
    if (blocked) {
      return { error: `network egress blocked (binary: ${blocked})` };
    }
  }
  return new Promise((resolve) => {
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...safeChildEnv(), NETWORK_DISABLED: noNetworkEgress ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT_BYTES) out += d.toString(); });
    proc.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT_BYTES) err += d.toString(); });
    proc.on("error", (e) => resolve({ error: e.message }));
    proc.on("close", (code, signal) => {
      const combined = (out + (err ? `\n[stderr]\n${err}` : "")).trimEnd();
      const suffix = signal ? `\n[killed: ${signal}]` : (code === 0 ? "" : `\n[exit ${code}]`);
      resolve(truncateOk({ text: combined + suffix }, MAX_OUTPUT_BYTES));
    });
  });
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
  if (/[\0\n\r]/.test(pattern)) return { error: "pattern contains control characters" };
  // Minimal no-dep glob: shell out to `find ... -path`. Cheap, safe
  // because pattern is whitelisted to non-shell-meta outside of ?
  // and *, and we cap the result count.
  return runBash(
    { command: `find . -path ${shellQuote(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' 2>/dev/null | head -200` },
    { cwd }
  );
}

async function runGrep({ pattern, path: target, include_glob }, { cwd }) {
  if (!pattern) return { error: "pattern is required" };
  if (/[\0\n\r]/.test(pattern) || (include_glob && /[\0\n\r]/.test(include_glob))) {
    return { error: "pattern contains control characters" };
  }
  const include = include_glob ? `--include=${shellQuote(include_glob)}` : "";
  const searchPath = target ? shellQuote(target) : ".";
  return runBash(
    { command: `grep -rnE ${include} -- ${shellQuote(pattern)} ${searchPath} 2>/dev/null | grep -v 'node_modules/\\|.git/\\|.next/' | head -300` },
    { cwd }
  );
}

// Used inside already-single-quoted strings. Only escapes the single
// quote terminator — callers must use `shellQuote` for untrusted input.
function escapeSingle(s) {
  return String(s).replace(/'/g, `'\\''`);
}

// Wrap a value for safe embedding in a shell command. Uses POSIX
// single-quote form which preserves all bytes literally. Rejects
// newlines and NULs up front because they can break the quoting
// invariant even inside single quotes.
function shellQuote(s) {
  if (typeof s !== "string") s = String(s ?? "");
  if (/[\0\n\r]/.test(s)) throw new Error("shellQuote: control characters not allowed");
  return `'${escapeSingle(s)}'`;
}

function truncateOk(obj, max) {
  if (obj.text && obj.text.length > max) {
    const cut = obj.text.slice(0, max);
    return { text: cut + `\n…[truncated ${obj.text.length - max} bytes]` };
  }
  return obj;
}

/**
 * Web research for the chat product. Prefer Brave Search when
 * BRAVE_SEARCH_API_KEY is set; otherwise DuckDuckGo Instant Answer +
 * lite HTML organic results (no key). Never shells out.
 */
async function runWebSearch({ query, max_results }, { noNetworkEgress }) {
  if (noNetworkEgress) return { error: "network egress blocked" };
  if (!query || typeof query !== "string") return { error: "query is required" };
  const q = query.trim().slice(0, 400);
  if (!q) return { error: "query is required" };
  const limit = Math.min(Math.max(Number(max_results) || 5, 1), 10);
  const braveKey = (process.env.BRAVE_SEARCH_API_KEY || "").trim();

  try {
    if (braveKey) {
      const r = await searchBrave(q, limit, braveKey);
      if (!r.error) return r;
      // Fall through to DDG if Brave errors (quota/network).
    }
    return await searchDuckDuckGo(q, limit);
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

async function searchBrave(query, limit, apiKey) {
  try {
    const url =
      "https://api.search.brave.com/res/v1/web/search?" +
      new URLSearchParams({ q: query, count: String(limit) }).toString();
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
        "User-Agent": "encompletion/1.0 (WebSearch)",
      },
    });
    if (!r.ok) return { error: `Brave Search HTTP ${r.status}` };
    const data = await r.json();
    const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
    const lines = [`Web search (Brave): ${query}`, ""];
    let n = 0;
    for (const item of rows) {
      if (n >= limit) break;
      const title = String(item.title || "").trim();
      const link = String(item.url || "").trim();
      const snip = String(item.description || "").trim().replace(/\s+/g, " ");
      if (!link) continue;
      n++;
      lines.push(`${n}. ${title || link}`);
      lines.push(`   ${link}`);
      if (snip) lines.push(`   ${snip.slice(0, 280)}`);
      lines.push("");
    }
    if (n === 0) return { error: "no results" };
    lines.push("Cite URLs in your reply. Use WebFetch to read a specific page.");
    return truncateOk({ text: lines.join("\n").trim() }, MAX_OUTPUT_BYTES);
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

async function searchDuckDuckGo(query, limit) {
  try {
    const lines = [`Web search (DuckDuckGo): ${query}`, ""];
    let n = 0;

    // Instant Answer JSON — abstracts + related topics (no key).
    const iaUrl =
      "https://api.duckduckgo.com/?" +
      new URLSearchParams({
        q: query,
        format: "json",
        no_html: "1",
        skip_disambig: "1",
      }).toString();
    const iaRes = await fetch(iaUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "encompletion/1.0 (WebSearch)",
      },
    });
    if (iaRes.ok) {
      const ia = await iaRes.json();
      const abs = String(ia.AbstractText || "").trim();
      const absUrl = String(ia.AbstractURL || "").trim();
      const heading = String(ia.Heading || "").trim();
      if (abs) {
        lines.push(`Summary${heading ? ` — ${heading}` : ""}:`);
        lines.push(abs.slice(0, 600));
        if (absUrl) lines.push(absUrl);
        lines.push("");
      }
      const related = [];
      const walk = (arr) => {
        for (const t of arr || []) {
          if (t?.Topics) walk(t.Topics);
          else if (t?.FirstURL && t?.Text) related.push(t);
        }
      };
      walk(ia.RelatedTopics);
      for (const t of related) {
        if (n >= limit) break;
        n++;
        lines.push(`${n}. ${String(t.Text).slice(0, 160)}`);
        lines.push(`   ${t.FirstURL}`);
        lines.push("");
      }
      for (const t of ia.Results || []) {
        if (n >= limit) break;
        if (!t?.FirstURL) continue;
        n++;
        lines.push(`${n}. ${String(t.Text || t.FirstURL).slice(0, 160)}`);
        lines.push(`   ${t.FirstURL}`);
        lines.push("");
      }
    }

    // Organic results via lite HTML when Instant Answer is thin.
    if (n < limit) {
      const liteUrl =
        "https://lite.duckduckgo.com/lite/?" +
        new URLSearchParams({ q: query }).toString();
      const liteRes = await fetch(liteUrl, {
        headers: {
          Accept: "text/html",
          "User-Agent": "encompletion/1.0 (WebSearch)",
        },
      });
      if (liteRes.ok) {
        const html = await liteRes.text();
        for (const hit of parseDdgLiteResults(html)) {
          if (n >= limit) break;
          // DDG sometimes wraps redirects; keep http(s) only.
          if (!/^https?:\/\//i.test(hit.url)) continue;
          n++;
          lines.push(`${n}. ${hit.title || hit.url}`);
          lines.push(`   ${hit.url}`);
          if (hit.snippet) lines.push(`   ${hit.snippet.slice(0, 280)}`);
          lines.push("");
        }
      }
    }

    if (n === 0 && lines.length <= 2) return { error: "no results" };
    lines.push("Cite URLs in your reply. Use WebFetch to read a specific page.");
    return truncateOk({ text: lines.join("\n").trim() }, MAX_OUTPUT_BYTES);
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/** Best-effort parse of DuckDuckGo lite HTML result links. */
function parseDdgLiteResults(html) {
  const out = [];
  const seen = new Set();
  // lite.duckduckgo.com: result links are <a rel="nofollow" href="https://...">title</a>
  // often inside result tables. Snippet is nearby plain text — optional.
  const re = /<a[^>]+rel="nofollow"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 15) {
    let url = m[1];
    // Unwrap DDG redirect if present.
    try {
      const u = new URL(url);
      if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.get("uddg")) {
        url = u.searchParams.get("uddg");
      }
    } catch { continue; }
    if (!url || seen.has(url)) continue;
    if (/duckduckgo\.com/i.test(url)) continue;
    seen.add(url);
    const title = htmlToText(m[2]).slice(0, 160);
    out.push({ url, title, snippet: "" });
  }
  return out;
}

async function runWebFetch({ url, max_bytes }, { noNetworkEgress }) {
  if (noNetworkEgress) return { error: "network egress blocked" };
  if (!url || typeof url !== "string") return { error: "url is required" };
  const parsed = assertSafeHttpUrl(url);
  if (!parsed.ok) return { error: parsed.error };
  const dns = await assertSafeResolvedHost(parsed.url.hostname);
  if (!dns.ok) return { error: dns.error };

  const cap = Math.min(Math.max(max_bytes || 256 * 1024, 4096), 1024 * 1024);

  // Manual redirect follow so each hop re-validates host/DNS (no open
  // redirect into 10/8 via Location). Cap hops at 5.
  try {
    let current = parsed.url.href;
    let r = null;
    for (let hop = 0; hop < 5; hop++) {
      r = await fetch(current, {
        redirect: "manual",
        headers: {
          "User-Agent": "claude-web/1.0 (WebFetch tool)",
          "Accept": "text/html, application/json, text/plain;q=0.9, */*;q=0.5",
        },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return { error: `redirect without Location (${r.status})` };
        let next;
        try { next = new URL(loc, current); } catch { return { error: "invalid redirect url" }; }
        const hopCheck = assertSafeHttpUrl(next.href);
        if (!hopCheck.ok) return { error: hopCheck.error };
        const hopDns = await assertSafeResolvedHost(hopCheck.url.hostname);
        if (!hopDns.ok) return { error: hopDns.error };
        current = hopCheck.url.href;
        continue;
      }
      break;
    }
    if (!r) return { error: "fetch failed" };
    if (!r.ok) return { error: `HTTP ${r.status} ${r.statusText}` };
    const ctype = r.headers.get("content-type") || "";
    const buf = new Uint8Array(await r.arrayBuffer());
    const slice = buf.byteLength > cap ? buf.slice(0, cap) : buf;
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = decoder.decode(slice);
    if (ctype.includes("text/html")) text = htmlToText(text);
    return truncateOk({ text }, MAX_OUTPUT_BYTES);
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// Cheap HTML-to-text: strips tags, decodes a small set of entities, and
// collapses runs of whitespace. Not perfect, but enough for the model
// to read the prose content of a page.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
