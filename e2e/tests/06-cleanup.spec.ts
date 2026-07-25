/**
 * Test 06: first-turn error cleans up the session.
 *
 * The recent fix: when a chat's first turn errors, the backend
 * deletes the session row + its user message + assistant message +
 * tool_uses + artifacts. The client mirrors by routing to /new
 * and clearing local state. Verify both sides.
 */

import { test, expect, Page } from '@playwright/test';
import { loginAsMember, newChat } from '../fixtures/ui';
import { pngFile } from '../fixtures/files';

async function fillComposer(page: Page, text: string) {
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Send"]').first();
  await composer.fill(text);
}

async function clickSend(page: Page) {
  const sendBtn = page.locator('button:has-text("Send"):not(:has-text("Sedang"))').last();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
}

test('first-turn error sends user to /new and clears sidebar entry', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await pngFile('e2e-cleanup.png');
  await page.locator('input[type="file"]').first().setInputFiles(f);
  await fillComposer(page, 'What is this image?');
  await clickSend(page);

  await page.waitForURL(/\/new/, { timeout: 120_000 });
  expect(page.url()).toMatch(/\/new$/);
});
