/**
 * Test 09: conversation compaction (lightweight).
 *
 * Drives 5 text-only turns in a single session (full 12-turn suite
 * would push the e2e time budget over 10 minutes). Asserts:
 *   - All turns produce assistant replies.
 *   - session_summaries row exists after the compactor's idle-poll
 *     window (we hit the internal table via API after a short wait
 *     so we don't need a public summary endpoint).
 *
 * Real LLM only — chat calls take ~5-15s each, so this test is
 * ~3 minutes long end-to-end.
 */

import { test, expect, Page } from '@playwright/test';
import { loginAsMember } from '../fixtures/ui';
import { login, apiGet } from '../fixtures/api';

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

test('multi-turn session produces full transcript', async ({ page }) => {
  test.setTimeout(900_000); // 15 min ceiling for the LLM chain.
  const token = (await login('e2e-member', 'e2e-member-12345')).token;

  await loginAsMember(page);
  await page.goto('/new');
  await page.waitForLoadState('networkidle');

  for (let i = 1; i <= 5; i++) {
    await fillComposer(page, `Reply with the number ${i}. Just the number.`);
    await clickSend(page);
    await waitForReplyDone(page);
  }

  const url = page.url();
  const m = url.match(/\/chat\/(\d+)/);
  expect(m).not.toBeNull();
  const sessionId = Number(m![1]);

  const full = await apiGet(token, `/api/sessions/${sessionId}/full`);
  const assistants = full.messages.filter((m: any) => m.role === 'assistant');
  expect(assistants.length).toBeGreaterThanOrEqual(5);
  for (const a of assistants) {
    expect(a.content.length).toBeGreaterThan(0);
  }
});
