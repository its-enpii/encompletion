/**
 * Test 12: embed admin tenant CRUD + key lifecycle.
 *
 * Validates the admin-facing surface for tenants + API keys:
 *   1. Create a tenant, then list to confirm.
 *   2. Patch the tenant's status.
 *   3. Issue an API key, then revoke it.
 *   4. Suspended tenant issues no embed tokens.
 *
 * 4 flows, no real chat — pure admin CRUD.
 */

import { test, expect } from '@playwright/test';
import { SEED } from '../fixtures/auth';

const BASE = process.env.E2E_BASE_URL || 'http://nginx:80';

async function adminToken() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin12345' }),
  });
  return (await r.json()).token;
}

test('admin creates a tenant and lists it', async () => {
  const tok = await adminToken();
  const slug = `e2e-t-${Date.now()}`;
  const create = await fetch(`${BASE}/api/admin/embed/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'E2E Test Tenant', slug }),
  });
  expect(create.ok).toBe(true);
  const tenant = await create.json();

  const list = await fetch(`${BASE}/api/admin/embed/tenants`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const arr = await list.json();
  expect(arr.some((t: any) => t.id === tenant.id)).toBe(true);

  // Cleanup: suspend so it's not active. (No DELETE endpoint
  // exists for tenants by design.)
  await fetch(`${BASE}/api/admin/embed/tenants/${tenant.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ status: 'suspended' }),
  });
});

test('tenant slug uniqueness enforced', async () => {
  const tok = await adminToken();
  const slug = `e2e-dup-${Date.now()}`;
  const a = await fetch(`${BASE}/api/admin/embed/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'A', slug }),
  });
  expect(a.ok).toBe(true);

  // Second create with the same slug should 409.
  const b = await fetch(`${BASE}/api/admin/embed/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'B', slug }),
  });
  expect(b.status).toBe(409);

  // Cleanup.
  const aTenant = await a.json();
  await fetch(`${BASE}/api/admin/embed/tenants/${aTenant.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ status: 'suspended' }),
  });
});

test('admin issues and revokes an API key', async () => {
  const tok = await adminToken();
  // Issue on the e2e tenant.
  const issue = await fetch(
    `${BASE}/api/admin/embed/tenants/${SEED.tenant.id}/api-keys`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'e2e-revocable' }),
    }
  );
  expect(issue.ok).toBe(true);
  const { id, plaintext } = await issue.json();
  expect(plaintext).toMatch(/^tk_/);

  // Use it to issue an embed token.
  const useToken = await fetch(`${BASE}/api/embed/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ external_user_id: 'e2e-revoke-test' }),
  });
  expect(useToken.ok).toBe(true);

  // Revoke.
  const revoke = await fetch(
    `${BASE}/api/admin/embed/tenants/${SEED.tenant.id}/api-keys/${id}/revoke`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}` },
    }
  );
  expect(revoke.ok).toBe(true);

  // Use should now fail.
  const useAfter = await fetch(`${BASE}/api/embed/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ external_user_id: 'e2e-revoke-test' }),
  });
  expect(useAfter.status).toBe(401);
});

test('suspended tenant rejects embed token issuance', async () => {
  const tok = await adminToken();
  const slug = `e2e-susp-${Date.now()}`;
  const create = await fetch(`${BASE}/api/admin/embed/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'Susp', slug }),
  });
  const tenant = await create.json();

  // Issue a key while active.
  const issue = await fetch(
    `${BASE}/api/admin/embed/tenants/${tenant.id}/api-keys`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ name: 'k' }),
    }
  );
  const { plaintext } = await issue.json();

  // Suspend.
  await fetch(`${BASE}/api/admin/embed/tenants/${tenant.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ status: 'suspended' }),
  });

  // Token issuance should fail with 403.
  const useAfter = await fetch(`${BASE}/api/embed/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ external_user_id: 'x' }),
  });
  expect(useAfter.status).toBe(403);
});
