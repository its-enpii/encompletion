/**
 * Test 08: project memory facts CRUD + project-scoped injection.
 *
 * Pure API test for the fact CRUD path (the project-facts UI lives
 * inside the project settings panel and is out of scope for the
 * chat-focused e2e suite). Verifies scoping + cap + cascade-delete.
 */

import { test, expect } from '@playwright/test';
import { apiPost, apiPut, apiDelete, apiGet, login } from '../fixtures/api';

test('project fact round-trips and is scoped per project', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  const projA = await apiPost(token, '/api/projects', {
    name: `e2e-proj-a-${Date.now()}`,
    description: 'A',
  });
  const projB = await apiPost(token, '/api/projects', {
    name: `e2e-proj-b-${Date.now()}`,
    description: 'B',
  });

  try {
    const fact = await apiPut(token, `/api/projects/${projA.id}/facts/stack`, {
      value: 'Laravel 11 with PHP 8.3',
    });
    expect(fact.key).toBe('stack');
    expect(fact.value).toContain('Laravel 11');

    const listA = await apiGet(token, `/api/projects/${projA.id}/facts`);
    expect(listA.facts.length).toBe(1);

    const listB = await apiGet(token, `/api/projects/${projB.id}/facts`);
    expect(listB.facts.length).toBe(0);
  } finally {
    await apiDelete(token, `/api/projects/${projA.id}`).catch(() => {});
    await apiDelete(token, `/api/projects/${projB.id}`).catch(() => {});
  }
});

test('project fact cap enforced at 100', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;
  const proj = await apiPost(token, '/api/projects', {
    name: `e2e-cap-${Date.now()}`,
  });

  try {
    for (let i = 0; i < 100; i++) {
      const r = await apiPut(token, `/api/projects/${proj.id}/facts/k${i}`, {
        value: `v${i}`,
      });
      expect(r.key).toBe(`k${i}`);
    }
    const r = await fetch(
      `${process.env.E2E_BASE_URL}/api/projects/${proj.id}/facts/k100`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ value: 'overflow' }),
      }
    );
    expect(r.status).toBe(400);
  } finally {
    await apiDelete(token, `/api/projects/${proj.id}`).catch(() => {});
  }
});

test('deleting a project cascade-deletes its facts', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;
  const proj = await apiPost(token, '/api/projects', {
    name: `e2e-cascade-${Date.now()}`,
  });

  await apiPut(token, `/api/projects/${proj.id}/facts/key1`, { value: 'v1' });
  await apiDelete(token, `/api/projects/${proj.id}`);

  const r = await fetch(`${process.env.E2E_BASE_URL}/api/projects/${proj.id}/facts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(r.status).toBe(404);
});
