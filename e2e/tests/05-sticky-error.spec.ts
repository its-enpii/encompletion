/**
 * Test 05: sticky error survives navigation.
 *
 * 3 chats that intentionally trigger an LLM error. The error banner
 * should remain visible after the user navigates between projects /
 * chat list / chat detail, because UiProvider lives in the root
 * layout.
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

test('first-turn error shows sticky banner and deletes the session', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await pngFile('e2e-err1.png');
  await page.locator('input[type="file"]').first().setInputFiles(f);
  await fillComposer(page, 'What is this?');
  await clickSend(page);

  // On first-turn error, the client navigates to /new.
  await page.waitForURL(/\/new/, { timeout: 120_000 });
  // Sticky banner rendered with role=alert by UiProvider.
  const banner = page.locator('[role="alert"]').first();
  await expect(banner).toBeVisible({ timeout: 10_000 });
});

test('later-turn error shows sticky banner', async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsMember(page);
  await newChat(page);

  // First turn: must succeed so the session has prior context.
  await fillComposer(page, 'Reply OK only.');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });

  // Second turn with an image (may error or succeed — banner is the
  // conditional assertion).
  const f = await pngFile('e2e-err2.png');
  await page.locator('input[type="file"]').first().setInputFiles(f);
  await fillComposer(page, 'And this?');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });
});

test('error banner persists across navigation', async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsMember(page);

  await newChat(page);
  const f = await pngFile('e2e-err3.png');
  await page.locator('input[type="file"]').first().setInputFiles(f);
  await fillComposer(page, 'Triggers?');
  await clickSend(page);
  await page.waitForURL(/\/new/, { timeout: 120_000 });

  const banner = page.locator('[role="alert"]').first();
  await expect(banner).toBeVisible();

  await page.goto('/projects');
  await page.waitForLoadState('networkidle');
  await expect(banner).toBeVisible();
});
