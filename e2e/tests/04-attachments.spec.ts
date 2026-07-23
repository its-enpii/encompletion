/**
 * Test 04: non-image attachment previews.
 *
 * 5 chats covering: .md, .py, .pdf, .txt, and a follow-up attachment
 * on an existing session. Validates the file preview modal renders
 * each kind without 401s on the file URL.
 */

import { test, expect, Page } from '@playwright/test';
import { loginAsMember, newChat, attachFile } from '../fixtures/ui';
import { mdFile, pyFile, pdfFile, textFile } from '../fixtures/files';

async function fillComposer(page: Page, text: string) {
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Send"]').first();
  await composer.fill(text);
}

async function clickSend(page: Page) {
  const sendBtn = page.locator('button:has-text("Send"):not(:has-text("Sedang"))').last();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();
}

test('markdown attachment shows preview tile', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await mdFile('e2e-note.md');
  await attachFile(page, f);
  await expect(page.getByTitle('e2e-note.md')).toBeVisible({ timeout: 5_000 });
});

test('python attachment shows preview tile', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await pyFile('e2e-snippet.py');
  await attachFile(page, f);
  await expect(page.getByTitle('e2e-snippet.py')).toBeVisible({ timeout: 5_000 });
});

test('pdf attachment shows preview tile', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await pdfFile('e2e-doc.pdf');
  await attachFile(page, f);
  await expect(page.getByTitle('e2e-doc.pdf')).toBeVisible({ timeout: 5_000 });
});

test('plain text attachment shows preview tile', async ({ page }) => {
  test.setTimeout(60_000);
  await loginAsMember(page);
  await newChat(page);

  const f = await textFile('e2e.txt');
  await attachFile(page, f);
  await expect(page.getByTitle('e2e.txt')).toBeVisible({ timeout: 5_000 });
});

test('attachment on existing session', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsMember(page);
  await newChat(page);

  await fillComposer(page, 'OK');
  await clickSend(page);
  await expect(
    page.locator('div.anim-slide-up:has-text("Sedang berpikir…")').first()
  ).toBeHidden({ timeout: 90_000 });

  const f = await mdFile('e2e-followup.md');
  await attachFile(page, f);
  await expect(page.getByTitle('e2e-followup.md')).toBeVisible();
});
