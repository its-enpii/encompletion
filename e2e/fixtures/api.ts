/**
 * API helpers. Bypass the browser to set up state (create projects,
 * add memory facts, etc) so tests stay focused on the UI surface.
 *
 * Goes through nginx so it exercises the same routing + auth path the
 * browser does. Token comes from the seeder's e2e-member user — admin
 * would also work but member is the realistic test persona.
 */

import { SEED } from './auth';

const BASE = process.env.E2E_BASE_URL || 'http://nginx:80';

export type AuthToken = { token: string; user: { id: number; username: string; role: string } };

export async function login(username: string, password: string): Promise<AuthToken> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`login failed for ${username}: ${r.status} ${text}`);
  }
  return r.json();
}

async function authedFetch(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export async function apiGet(token: string, path: string) {
  const r = await authedFetch(token, path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}

export async function apiPost(token: string, path: string, body: any) {
  const r = await authedFetch(token, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`POST ${path}: ${r.status} ${t}`);
  }
  return r.json();
}

export async function apiPut(token: string, path: string, body: any) {
  const r = await authedFetch(token, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PUT ${path}: ${r.status} ${t}`);
  }
  return r.json();
}

export async function apiDelete(token: string, path: string) {
  const r = await authedFetch(token, path, { method: 'DELETE' });
  if (!r.ok) throw new Error(`DELETE ${path}: ${r.status}`);
  return r.json();
}

/** Issue a fresh embed token for the test tenant via the server-to-server
 *  flow. Mirrors what a Laravel saas-app would do in production. */
export async function issueEmbedToken(
  tenantKey: string,
  externalUserId: string
): Promise<{ embed_token: string; expires_at: string }> {
  const r = await fetch(`${BASE}/api/embed/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tenantKey}`,
    },
    body: JSON.stringify({ external_user_id: externalUserId }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`embed token issue failed: ${r.status} ${t}`);
  }
  return r.json();
}

export { SEED };
