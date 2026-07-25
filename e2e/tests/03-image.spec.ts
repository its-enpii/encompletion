/**
 * Test 03: image attachment + preview modal.
 *
 * 4 chats covering: image-only first turn, image + text, two
 * images, and image in a non-first turn. Validates the in-bubble
 * thumbnail, the modal preview, and the file URL token plumbing.
 */

import { test, expect, Page } from '@playwright/test';
import { loginAsMember, newChat, attachFile, sendChatAndWaitForReply } from '../fixtures/ui';
import { pngFile } from '../fixtures/files';

async function fillComposer(page: Page, text: string) {
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Send"]').first();
  await expect(composer).toBeVisible();
  await composer.fill(text);
}

async function clickSend(page: Page) {
  // Composer renders Send as <button> + <kbd>. Use a text-contains
  // match to skip the Stop button's "Sedang berpikir…" label.
  const sendBtn = page.locator('button:has-text("Send"):not(:has-text("Sedang"))').last();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
}

test('image-only first turn: tile preview + assistant reply', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsMember(page);

  const file = await pngFile('e2e-pixel.png');
  await newChat(page);
  await attachFile(page, file);

  await expect(page.getByTitle('e2e-pixel.png')).toBeVisible({ timeout: 5_000 });

  await fillComposer(page, 'What do you see?');
  await clickSend(page);
  // TypingPill appears in the bubble area; wait for it to vanish.
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });

  // The image in the user bubble should load.
  const userImg = page.locator('img[alt="e2e-pixel.png"]').first();
  await expect(userImg).toBeVisible({ timeout: 60_000 });

  const lastAssistant = page
    .locator('div.anim-slide-up')
    .filter({ hasText: /^Asisten/ })
    .last();
  await expect(lastAssistant).toBeVisible();
});

test('image + text on existing session', async ({ page }) => {
  test.setTimeout(300_000);
  await loginAsMember(page);
  await newChat(page);

  await fillComposer(page, 'Acknowledge with OK.');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });

  const file = await pngFile('e2e-pixel-2.png');
  await attachFile(page, file);
  await expect(page.getByTitle('e2e-pixel-2.png')).toBeVisible();
  await fillComposer(page, 'And the color?');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });
});

test('two images attached at once', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsMember(page);
  await newChat(page);

  const a = await pngFile('e2e-a.png');
  const b = await pngFile('e2e-b.png');
  await attachFile(page, a);
  await attachFile(page, b);
  await expect(page.getByTitle('e2e-a.png')).toBeVisible();
  await expect(page.getByTitle('e2e-b.png')).toBeVisible();
});

test('image preview modal opens on click', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsMember(page);
  await newChat(page);

  const file = await pngFile('e2e-modal.png');
  await attachFile(page, file);
  await fillComposer(page, 'Look at this image please.');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });

  // Click the image in the user bubble to open the modal.
  const userImg = page.locator('img[alt="e2e-modal.png"]').first();
  await userImg.click();
  // The modal renders a second <img> with the same alt.
  const allImgs = page.locator('img[alt="e2e-modal.png"]');
  await expect(async () => {
    expect(await allImgs.count()).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});

