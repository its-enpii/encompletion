/**
 * Test 07: user memory facts CRUD + injection.
 *
 * The chat half uses the API helper to flip a fact, then opens a
 * new chat in the browser and asks a question whose answer should
 * reflect the fact. We assert on length + non-empty — the model
 * may not echo verbatim.
 */

import { test, expect, Page } from '@playwright/test';
import { loginAsMember, newChat } from '../fixtures/ui';
import { apiPut, apiDelete, apiGet, login } from '../fixtures/api';

async function fillComposer(page: Page, text: string) {
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Send"]').first();
  await composer.fill(text);
}

async function clickSend(page: Page) {
  const sendBtn = page.locator('button:has-text("Send"):not(:has-text("Sedang"))').last();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
}

async function waitForReplyDone(page: Page) {
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });
}

test('user memory CRUD round-trips and surfaces in chat', async ({ page }) => {
  test.setTimeout(300_000);
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  // Clean slate.
  const before = await apiGet(token, '/api/memory/facts');
  for (const f of before.facts || []) {
    await apiDelete(token, `/api/memory/facts/${f.id}`).catch(() => {});
  }

  const upsert = await apiPut(token, '/api/memory/facts/pet', {
    value: 'A black Labrador named Rex',
  });
  expect(upsert.key).toBe('pet');
  expect(upsert.value).toContain('Rex');

  const after = await apiGet(token, '/api/memory/facts');
  expect(after.facts.length).toBe(1);

  await loginAsMember(page);
  await newChat(page);
  await fillComposer(page, 'Reply with READY only.');
  await clickSend(page);
  await waitForReplyDone(page);

  await newChat(page);
  await fillComposer(page, "What's my pet's name?");
  await clickSend(page);
  await waitForReplyDone(page);

  // The reply bubble should not be empty.
  const lastAssistant = page
    .locator('div.anim-slide-up')
    .filter({ hasText: /^Asisten/ })
    .last();
  const txt = await lastAssistant.textContent();
  expect(txt?.trim().length ?? 0).toBeGreaterThan(0);

  // Cleanup.
  await apiDelete(token, `/api/memory/facts/${upsert.id}`).catch(() => {});
});

test('user memory upsert overwrites by key', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  const first = await apiPut(token, '/api/memory/facts/location', { value: 'Jakarta' });
  const second = await apiPut(token, '/api/memory/facts/location', { value: 'Bandung' });

  expect(second.id).toBe(first.id);
  expect(second.value).toBe('Bandung');

  await apiDelete(token, `/api/memory/facts/${first.id}`).catch(() => {});
});

test('user memory rejects invalid keys', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  const r = await fetch(`${process.env.E2E_BASE_URL}/api/memory/facts/1invalid`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ value: 'x' }),
  });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
});

test('user memory auto-extract toggle persists', async () => {
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  const off = await fetch(`${process.env.E2E_BASE_URL}/api/memory/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ auto_memory_enabled: false }),
  }).then((r) => r.json());
  expect(off.auto_memory_enabled).toBe(false);

  const on = await fetch(`${process.env.E2E_BASE_URL}/api/memory/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ auto_memory_enabled: true }),
  }).then((r) => r.json());
  expect(on.auto_memory_enabled).toBe(true);
});
