/**
 * Test 02: text-only chat — happy path.
 *
 * 3 chats in sequence: each must produce an assistant reply that
 * lands in the bubble. Validates the SSE stream, the loadSession
 * fallback on `done`, and the sidebar session list.
 */

import { test, expect } from '@playwright/test';
import { loginAsMember, sendChatAndWaitForReply, newChat } from '../fixtures/ui';

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
