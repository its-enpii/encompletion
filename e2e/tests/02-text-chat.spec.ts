/**
 * Test 02: text-only chat — happy path.
 *
 * 3 chats in sequence: each must produce an assistant reply that
 * lands in the bubble. Validates the SSE stream, the loadSession
 * fallback on `done`, and the sidebar session list.
 */

import { test, expect } from '@playwright/test';
import { loginAsMember, sendChatAndWaitForReply, newChat } from '../fixtures/ui';
import { apiPost, login } from '../fixtures/api';

test('three text chats in sequence all produce assistant replies', async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsMember(page);

  const prompts = [
    'Reply with the single word PONG and nothing else.',
    'What is 2 + 2? Reply with the number only.',
    'Name the capital of France. One word.',
  ];

  for (let i = 0; i < prompts.length; i++) {
    await newChat(page);
    const reply = await sendChatAndWaitForReply(page, prompts[i]);
    expect(reply.trim().length).toBeGreaterThan(0);
  }
});

test('new chat shows up in the sidebar after the first message', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAsMember(page);

  // Sidebar rows are <button>s with the session title in the
  // accessible name. Title comes from the first user message
  // (truncated to 60 chars). Send a uniquely-titled prompt so we
  // can assert its presence in the list after the chat completes.
  const sidebar = page.locator('aside, nav').first();
  await sidebar.waitFor();

  const uniqueTag = 'sidebarcheck' + Date.now();
  await newChat(page);
  await sendChatAndWaitForReply(page, `${uniqueTag} say HI and stop.`);

  // Wait for the sidebar to refetch (`app:sessions-changed`
  // event) and for the new session row to mount with our title.
  await expect(async () => {
    const found = await sidebar.locator(`ul > li :text("${uniqueTag}")`).count();
    expect(found).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
});

test('sidebar "Show more" link appears when total > 20 and opens search dialog', async ({ page }) => {
  test.setTimeout(120_000);
  // Seed 25 extra sessions via API so total > 20 (the sidebar cap).
  // Use a unique title prefix so cleanup doesn't nuke unrelated rows.
  const tok = (await login('e2e-member', 'e2e-member-12345')).token;
  const tag = 'showmore-' + Date.now();
  for (let i = 0; i < 25; i++) {
    await apiPost(tok, '/api/sessions', { title: `${tag} ${i}` });
  }

  await loginAsMember(page);
  const sidebar = page.locator('aside, nav').first();
  await sidebar.waitFor();

  // The link renders below the list and shows the count of hidden rows.
  const showMore = sidebar.locator('button:has-text("Show more")');
  await expect(showMore).toBeVisible({ timeout: 10_000 });
  // Hidden count is total - 20; with 25 seeded plus any leftover from
  // earlier runs we expect at least 6 hidden.
  const txt = await showMore.textContent();
  const m = txt?.match(/(\d[\d,]*)\s+older session/);
  expect(m).not.toBeNull();
  const hidden = Number(m![1].replace(/,/g, ''));
  expect(hidden).toBeGreaterThanOrEqual(5);

  // Clicking the link opens the search dialog.
  await showMore.click();
  // Dialog is a modal — match by its placeholder which is distinct from
  // the sidebar's "Cari di semua session…" input.
  const dialogInput = page.locator('input[placeholder*="Cari"], input[placeholder*="search" i]').last();
  await expect(dialogInput).toBeVisible({ timeout: 5_000 });

  // Cleanup: delete the 25 seeded rows so subsequent runs aren't polluted.
  const list = await page.evaluate(async () => {
    const t = localStorage.getItem('app:token');
    const r = await fetch('/api/sessions?limit=500', { headers: { Authorization: `Bearer ${t}` } });
    return r.json();
  });
  for (const s of list as any[]) {
    if ((s.title || '').startsWith(tag)) {
      await page.evaluate(async (id) => {
        const t = localStorage.getItem('app:token');
        await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });
      }, s.id);
    }
  }
});
