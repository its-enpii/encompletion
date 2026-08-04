import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = path.join(__dirname, 'document-build-guard.cjs');
const BACKEND_ROOT = path.resolve(__dirname, '..');
const NODE_MODULES_PATH = path.join(BACKEND_ROOT, 'node_modules');

const MAX_OUTPUT_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const BUILD_TIMEOUT_MS = Math.max(5_000, Number(process.env.DOCUMENT_BUILD_TIMEOUT_MS) || 60_000);
const ALLOWED_EXTENSIONS = new Set([
  '.docx', '.html', '.jpeg', '.jpg', '.pdf', '.png', '.pptx', '.svg', '.xlsx',
]);

function resolveInside(root, target) {
  if (!target || typeof target !== 'string') throw new Error('path is required');
  const base = path.resolve(root);
  const absolute = path.resolve(base, target);
  const relative = path.relative(base, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes document workspace: ${target}`);
  }
  return absolute;
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_LOG_BYTES) return current;
  return (current + chunk.toString('utf8')).slice(0, MAX_LOG_BYTES);
}

export async function runDocumentBuild({ cwd, entrypoint, outputs, timeoutMs = BUILD_TIMEOUT_MS }) {
  if (!cwd) return { error: 'document workspace is required' };
  if (!Array.isArray(outputs) || outputs.length === 0) return { error: 'at least one output is required' };
  if (outputs.length > MAX_OUTPUT_FILES) return { error: `too many outputs (>${MAX_OUTPUT_FILES})` };

  let workspaceReal;
  try {
    workspaceReal = await fsp.realpath(cwd);
  } catch {
    return { error: 'document workspace is missing' };
  }

  let entrypointPath;
  try {
    entrypointPath = resolveInside(workspaceReal, entrypoint);
    const entryReal = await fsp.realpath(entrypointPath);
    const entryRelative = path.relative(workspaceReal, entryReal);
    if (entryRelative.startsWith('..') || path.isAbsolute(entryRelative)) {
      return { error: 'entrypoint symlinks are not allowed' };
    }
    const stat = await fsp.stat(entryReal);
    if (!stat.isFile()) return { error: 'entrypoint is not a file' };
    if (!['.js', '.mjs', '.cjs'].includes(path.extname(entryReal).toLowerCase())) {
      return { error: 'entrypoint must be a JavaScript file' };
    }
  } catch (error) {
    return { error: error?.message || 'invalid entrypoint' };
  }

  const requestedOutputs = [];
  try {
    for (const output of outputs) {
      const relativePath = typeof output === 'string' ? output : output?.path;
      const absolutePath = resolveInside(workspaceReal, relativePath);
      const extension = path.extname(absolutePath).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new Error(`unsupported document output: ${relativePath}`);
      }
      requestedOutputs.push({
        path: relativePath.split(path.sep).join('/'),
        title: typeof output === 'object' && typeof output?.title === 'string'
          ? output.title.trim().slice(0, 160)
          : null,
        absolutePath,
        extension,
      });
    }
  } catch (error) {
    return { error: error?.message || 'invalid output path' };
  }

  const tempDir = path.join(workspaceReal, '.document-build-tmp');
  await fsp.mkdir(tempDir, { recursive: true });

  const args = [
    '--permission',
    `--allow-fs-read=${workspaceReal}`,
    `--allow-fs-read=${NODE_MODULES_PATH}`,
    `--allow-fs-read=${GUARD_PATH}`,
    `--allow-fs-write=${workspaceReal}`,
    '--max-old-space-size=512',
    '--disable-warning=ExperimentalWarning',
    '--disable-warning=ExperimentalPermission',
    '--require',
    GUARD_PATH,
    entrypointPath,
  ];
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceReal,
      env: {
        HOME: workspaceReal,
        NODE_ENV: 'production',
        TEMP: tempDir,
        TMP: tempDir,
        TMPDIR: tempDir,
        TZ: process.env.TZ || 'UTC',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, error });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal });
    });
  });

  if (timedOut) return { error: `document build timed out after ${timeoutMs}ms`, stdout, stderr };
  if (exit.error) return { error: exit.error.message, stdout, stderr };
  if (exit.code !== 0) {
    return {
      error: `document build failed with exit code ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`,
      stdout,
      stderr,
    };
  }

  const builtOutputs = [];
  let totalBytes = 0;
  for (const output of requestedOutputs) {
    let realPath;
    try {
      realPath = await fsp.realpath(output.absolutePath);
      const relative = path.relative(workspaceReal, realPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('output escapes workspace');
      const stat = await fsp.stat(realPath);
      if (!stat.isFile()) throw new Error('output is not a file');
      if (stat.size === 0) throw new Error('output is empty');
      if (stat.size > MAX_FILE_BYTES) throw new Error(`output exceeds ${MAX_FILE_BYTES} bytes`);
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`outputs exceed ${MAX_TOTAL_BYTES} bytes total`);
      builtOutputs.push({ ...output, realPath, size: stat.size });
    } catch (error) {
      return { error: `${output.path}: ${error?.message || 'output missing'}`, stdout, stderr };
    }
  }

  return { outputs: builtOutputs, stdout, stderr };
}

export const documentBuildLimits = {
  allowedExtensions: [...ALLOWED_EXTENSIONS],
  maxFiles: MAX_OUTPUT_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  timeoutMs: BUILD_TIMEOUT_MS,
};
