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

  const proc = spawn('claude', args, {
    cwd: opts.cwd || process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
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
    onEvent({ type: 'stderr', text: chunk.toString() });
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
