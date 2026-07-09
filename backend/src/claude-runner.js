import { spawn } from 'node:child_process';

/**
 * Spawn Claude Code CLI and stream stream-json events.
 * @param {string} prompt - User prompt
 * @param {object} opts
 * @param {string} [opts.model] - Model id (default: env DEFAULT_MODEL)
 * @param {string} [opts.sessionId] - Claude session id to --resume
 * @param {string} [opts.cwd] - Working directory for the spawned process
 * @param {(evt: object) => void} onEvent - Callback for each parsed JSON event
 * @returns {{ kill: () => void, proc: import('node:child_process').ChildProcess }}
 */
export function runClaude(prompt, opts = {}, onEvent) {
  const model = opts.model || process.env.DEFAULT_MODEL || 'workspace';
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (opts.effort && /^(low|medium|high|xhigh|max)$/.test(opts.effort)) {
    args.push('--effort', opts.effort);
  }
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  }

  // Build env carefully:
  // - Forward everything from process.env so PATH and the engine's own
  //   config files remain reachable.
  // - Always set TERM. When `claude` is spawned without a TTY and TERM
  //   is unset, it falls back to non-interactive model enforcement and
  //   refuses the explicit --model flag with "issue with the selected
  //   model". Setting a benign terminal type (xterm-256color) keeps
  //   model resolution paths happy without pulling in any of the real
  //   interactive UI behaviour.
  // - ANTHROPIC_BASE_URL / API_KEY are explicit so the spawned process
  //   cannot accidentally inherit a stale value from a different
  //   process env (e.g. a parent that swapped proxies at runtime).
  const { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ...rest } = process.env;
  const proc = spawn('claude', args, {
    cwd: opts.cwd || process.cwd(),
    env: {
      ...rest,
      TERM: process.env.TERM || 'xterm-256color',
      ANTHROPIC_BASE_URL,
      ANTHROPIC_API_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        onEvent(parsed);
      } catch {
        onEvent({ type: 'raw', text: line });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    // Mirror to server stdout so deploy logs surface real CLI errors
    // (model-not-found, auth failures, rate limits). Without this, a
    // failed Claude invocation only shows up as `result.isError = true`
    // in the UI with no actionable message on the server side.
    process.stderr.write(`[claude stderr] ${text}`);
    onEvent({ type: 'stderr', text });
  });

  proc.on('error', (err) => {
    onEvent({ type: 'error', message: err.message });
  });

  proc.on('close', (code) => {
    if (buffer.trim()) {
      try {
        onEvent(JSON.parse(buffer));
      } catch {
        onEvent({ type: 'raw', text: buffer });
      }
    }
    onEvent({ type: 'exit', code });
  });

  return {
    proc,
    kill: () => proc.kill('SIGTERM'),
  };
}
