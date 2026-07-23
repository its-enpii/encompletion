/**
 * Embed mode E4 isolation tests.
 *
 * Coverage:
 *   1. resolveEmbedWorkdir: per-tenant, per-user path under WORKDIR_ROOT
 *   2. sanitize: traversal tokens rejected
 *   3. Bash scan blocks curl/wget/nc etc. when noNetworkEgress=true
 *   4. Bash scan ignores safe commands (ls, cat, echo, node, etc.)
 *   5. Bash scan catches nested indirection (bash -c "curl ...")
 *   6. Bash scan ignores path-prefixed safe binaries
 *   7. ensureEmbedWorkdir creates the directory
 *   8. workdir isolation: tenant A and B get distinct paths
 *
 * These tests do NOT spawn shells or make HTTP calls — Bash scan is
 * pure-string and tools.js is pure logic. The integration with the
 * LLM loop is exercised end-to-end via the live smoke flow, not via
 * a fake LLM.
 *
 * Run: node --test src/embed-isolation-e4.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const { resolveEmbedWorkdir, ensureEmbedWorkdir } = await import('./embed-workdir.js');
const { runTool } = await import('./tools.js');

function makeCwd() {
  const dir = `/tmp/enc-test-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('resolveEmbedWorkdir returns per-tenant per-user path', () => {
  const a = ensureEmbedWorkdir('tenant-foo', 'user-1');
  const b = ensureEmbedWorkdir('tenant-foo', 'user-2');
  const c = ensureEmbedWorkdir('tenant-bar', 'user-1');
  assert.ok(a.endsWith('/tenants/tenant-foo/user-1'));
  assert.ok(b.endsWith('/tenants/tenant-foo/user-2'));
  assert.ok(c.endsWith('/tenants/tenant-bar/user-1'));
  assert.notEqual(a, b, 'same tenant, different user → different dir');
  assert.notEqual(a, c, 'different tenant → different dir');
});

test('resolveEmbedWorkdir rejects traversal tokens', () => {
  // The sanitizer strips path separators and dots-replaced tokens
  // become "_invalid" / "_blank" placeholders, which still live under
  // the tenant dir. The crucial property is that NONE of these
  // resolve outside WORKDIR_ROOT/tenants/<tenant>/...
  for (const hostile of ['../../../etc', '..', '.', 'user/../escape']) {
    const p = resolveEmbedWorkdir('tenant-foo', hostile);
    if (p !== null) {
      // Sanitizer rewrote it — must still be confined to the tenant dir.
      assert.ok(p.includes('/tenants/tenant-foo/'), `hostile id resolves under tenant: ${hostile} -> ${p}`);
      assert.ok(!p.includes('/etc/') && !p.endsWith('/etc'), `no escape to /etc: ${p}`);
    }
  }
  // Empty / blank → null.
  assert.equal(resolveEmbedWorkdir('tenant-foo', ''), null);
  assert.equal(resolveEmbedWorkdir('tenant-foo', '   '), null);
  // Null bytes get sanitized to underscore, ending up in a safe subdir.
  const sanitized = resolveEmbedWorkdir('tenant-foo', 'a\x00b');
  assert.ok(sanitized && sanitized.endsWith('/tenant-foo/a_b'));
});

test('resolveEmbedWorkdir rejects invalid tenant_id format', () => {
  assert.equal(resolveEmbedWorkdir('not-tenant-prefix', 'user'), null);
  assert.equal(resolveEmbedWorkdir('tenant-../escape', 'user'), null);
  assert.equal(resolveEmbedWorkdir('', 'user'), null);
  assert.equal(resolveEmbedWorkdir(null, 'user'), null);
});

test('ensureEmbedWorkdir creates the directory', () => {
  const tenantId = 'tenant-tmp-' + crypto.randomBytes(3).toString('hex');
  const p = ensureEmbedWorkdir(tenantId, 'fresh-user');
  assert.ok(p);
  assert.ok(fs.existsSync(p), 'directory created');
});

test('Bash scan blocks curl/wget/nc when noNetworkEgress=true', async () => {
  const cwd = makeCwd();
  for (const blocked of ['curl https://example.com', 'wget -q -O- https://x', 'nc -z 10.0.0.1 80', 'ssh user@host', 'npm install foo']) {
    const r = await runTool('Bash', { command: blocked }, { cwd, noNetworkEgress: true });
    assert.ok(r.error && r.error.includes('network egress blocked'), `blocked: ${blocked}, got: ${r.error}`);
  }
});

test('Bash scan allows safe commands when noNetworkEgress=true', async () => {
  const cwd = makeCwd();
  for (const safe of ['ls -la', 'cat README.md', 'echo hello', 'node --version', 'grep -r "foo" .']) {
    const r = await runTool('Bash', { command: safe }, { cwd, noNetworkEgress: true });
    const blocked = r.error ? r.error.includes('network egress blocked') : false;
    assert.equal(blocked, false, `allowed: ${safe}, got: ${r.error || 'ok'}`);
  }
});

test('Bash scan catches nested indirection', async () => {
  const cwd = makeCwd();
  // bash -c "curl ..." — token scan sees both tokens.
  const r = await runTool('Bash', { command: 'bash -c "curl https://example.com"' }, { cwd, noNetworkEgress: true });
  assert.ok(r.error, `expected error, got: ${JSON.stringify(r)}`);
  assert.ok(r.error.includes('network egress blocked'), `blocked nested: ${r.error}`);
});

test('Bash scan ignores path-prefixed safe binaries', async () => {
  const cwd = makeCwd();
  // /bin/ls → ls, not in deny list → allowed.
  const r = await runTool('Bash', { command: '/bin/ls -la' }, { cwd, noNetworkEgress: true });
  const blocked = r.error ? r.error.includes('network egress blocked') : false;
  assert.equal(blocked, false);
});

test('Bash scan does NOT block when noNetworkEgress=false (platform mode)', async () => {
  const cwd = makeCwd();
  // Even with curl in the command, platform mode is allowed.
  const r = await runTool('Bash', { command: 'curl --version 2>&1 || true' }, { cwd, noNetworkEgress: false });
  const blocked = r.error ? r.error.includes('network egress blocked') : false;
  assert.equal(blocked, false);
});

test('Bash scan also catches path-prefixed denylisted binaries', async () => {
  const cwd = makeCwd();
  const r = await runTool('Bash', { command: '/usr/bin/curl https://example.com' }, { cwd, noNetworkEgress: true });
  assert.ok(r.error, `expected error, got: ${JSON.stringify(r)}`);
  assert.ok(r.error.includes('network egress blocked'), `blocked path-prefixed: ${r.error}`);
});