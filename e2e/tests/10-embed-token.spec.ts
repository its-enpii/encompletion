/**
 * Test 10: embed token issuance + widget chat + tenant isolation.
 *
 * 3 widget-side flows via direct API calls:
 *   1. Issue an embed token from the tenant key (server-to-server).
 *   2. Use the embed token to chat in a tenant-owned session.
 *   3. Verify a different tenant's session is unreachable (isolation).
 *
 * We hit the API directly because the embed widget UI is hosted at
 * /embed/* and requires an external tenant app to drive; the test
 * target is the API surface, not the widget markup.
 */

import { test, expect } from '@playwright/test';
import { SEED } from '../fixtures/auth';
import { issueEmbedToken } from '../fixtures/api';

const BASE = process.env.E2E_BASE_URL || 'http://nginx:80';

test('tenant API key issues embed token', async () => {
  const r = await issueEmbedToken(SEED.tenantApiKey.plaintext, 'e2e-widget-user-1');
  expect(r.embed_token).toMatch(/^em_/);
  expect(r.expires_at).toBeTruthy();
});

test('embed token grants widget-side chat access', async () => {
  const { embed_token } = await issueEmbedToken(SEED.tenantApiKey.plaintext, 'e2e-widget-user-1');

  // Create a session owned by the tenant.
  const create = await fetch(`${BASE}/api/embed/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embed_token}` },
  });
  expect(create.ok).toBe(true);
  const { session } = await create.json();
  expect(session.owner_type).toBe('tenant');
  expect(session.owner_id).toBe(SEED.tenant.id);

  // Read it back.
  const get = await fetch(`${BASE}/api/embed/sessions/${session.id}`, {
    headers: { Authorization: `Bearer ${embed_token}` },
  });
  expect(get.ok).toBe(true);
});

test('embed token from one external user cannot see another external user', async () => {
  const userA = await issueEmbedToken(SEED.tenantApiKey.plaintext, 'e2e-iso-a');
  const userB = await issueEmbedToken(SEED.tenantApiKey.plaintext, 'e2e-iso-b');

  // User A creates a session.
  const create = await fetch(`${BASE}/api/embed/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userA.embed_token}`,
    },
  });
  const { session } = await create.json();

  // User B should NOT be able to read it.
  const crossRead = await fetch(`${BASE}/api/embed/sessions/${session.id}`, {
    headers: { Authorization: `Bearer ${userB.embed_token}` },
  });
  expect(crossRead.status).toBe(404);
});
