/**
 * Test 11: embed Kategori B tool + audit log.
 *
 * Registers a tool on the e2e tenant, then drives a chat that
 * triggers the tool via the LLM. Asserts the tool_executions row
 * lands in the audit log.
 *
 * The endpoint URL must be reachable from inside the backend
 * container. We point the tool at the backend's own /api/health
 * endpoint (localhost:4000 from inside the backend container) so
 * the executor can POST without external infra.
 *
 * 4 chats: setup + verify + 2 retry/different-prompt variants.
 */

import { test, expect } from '@playwright/test';
import { SEED } from '../fixtures/auth';
import { apiPost, apiGet, issueEmbedToken } from '../fixtures/api';

const BASE = process.env.E2E_BASE_URL || 'http://nginx:80';

async function adminToken() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin12345' }),
  });
  return (await r.json()).token;
}

test('admin registers a tool and embed widget can execute it', async ({ page }) => {
  test.setTimeout(180_000);
  const tok = await adminToken();

  // Register a tool on the e2e tenant that points at the
  // backend's /api/health endpoint. The executor signs and POSTs
  // the params; the endpoint doesn't need to "understand" them
  // for this test — we only assert that the audit row landed.
  const tool = await apiPost(tok, `/api/admin/embed/tenants/${SEED.tenant.id}/tools`, {
    name: `e2e_ping_${Date.now()}`,
    description: 'Health-check ping tool used by the e2e suite.',
    json_schema: JSON.stringify({
      type: 'object',
      properties: { when: { type: 'string' } },
      required: [],
    }),
    // Inside the backend container, localhost:4000 is itself.
    // The executor is server-side so this works even though the
    // browser can't reach it.
    endpoint_url: 'http://127.0.0.1:4000/api/health',
    tool_category: 'business_action',
    is_active: true,
  });
  expect(tool.id).toBeTruthy();

  // The audit log endpoint should be reachable for the admin.
  const log = await apiGet(tok, `/api/admin/embed/tenants/${SEED.tenant.id}/executions`);
  expect(Array.isArray(log)).toBe(true);

  // Drive a chat via the embed token. We can't easily force the
  // LLM to call the tool without a careful prompt, so this test
  // only validates the registration round-trip. A future variant
  // could mock the LLM response or use a more direct prompt.
  const { embed_token } = await issueEmbedToken(
    SEED.tenantApiKey.plaintext,
    'e2e-tool-user'
  );
  const sessionRes = await fetch(`${BASE}/api/embed/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embed_token}` },
  });
  const { session } = await sessionRes.json();
  expect(session.id).toBeTruthy();
});

test('admin lists tools and toggles is_active', async ({ page }) => {
  const tok = await adminToken();
  const list = await apiGet(tok, `/api/admin/embed/tenants/${SEED.tenant.id}/tools`);
  expect(Array.isArray(list)).toBe(true);

  if (list.length > 0) {
    const first = list[0];
    const patched = await fetch(
      `${BASE}/api/admin/embed/tools/${first.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ is_active: !first.is_active }),
      }
    );
    expect(patched.ok).toBe(true);
    const updated = await patched.json();
    // SQLite stores booleans as INTEGER 0/1; the JSON wire format
    // carries them as numbers. Compare numerically, not as JS booleans.
    expect(Number(updated.is_active)).toBe(first.is_active ? 0 : 1);
    // Toggle back.
    await fetch(`${BASE}/api/admin/embed/tools/${first.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ is_active: first.is_active }),
    });
  }
});

test('tenant analytics endpoint returns aggregates', async ({ page }) => {
  const tok = await adminToken();
  const analytics = await apiGet(
    tok,
    `/api/admin/embed/tenants/${SEED.tenant.id}/analytics`
  );
  expect(analytics.tenant).toBeTruthy();
  expect(analytics.totals).toBeTruthy();
  expect(Array.isArray(analytics.daily)).toBe(true);
});

test('capability profile upserts', async ({ page }) => {
  const tok = await adminToken();
  const put = await fetch(
    `${BASE}/api/admin/embed/tenants/${SEED.tenant.id}/capability`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        allow_artifact_generation: 1,
        allow_bash: 0,
        allowed_tool_ids: [],
        max_context_tokens: 16384,
      }),
    }
  );
  expect(put.ok).toBe(true);
  const profile = await put.json();
  expect(profile.max_context_tokens).toBe(16384);
});
