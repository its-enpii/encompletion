/**
 * UI helpers — high-level actions the tests compose into flows.
 *
 * Selectors are based on the actual DOM (placeholders, role+name,
 * text labels) — no data-testid because the components don't ship any.
 */

import { expect, Page } from '@playwright/test';
import { ADMIN, MEMBER } from './auth';

const LOGIN_TIMEOUT = 20_000;
const REPLY_TIMEOUT = 90_000;

export async function loginAs(page: Page, user: { username: string; password: string }) {
  await page.goto('/login');
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  const usernameInput = page.getByLabel(/username/i);
  const passwordInput = page.getByLabel(/password/i);
  await usernameInput.fill(user.username);
  await passwordInput.fill(user.password);
  // The submit button has the text "Masuk" in Indonesian; match
  // either locale. The AuthProvider's login() will trigger a
  // navigation away from /login on success.
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), {
      timeout: LOGIN_TIMEOUT,
    }),
    page.getByRole('button', { name: /masuk|log\s*in|sign\s*in/i }).click(),
  ]);
  // Wait for the sidebar's brand + chat header to render. The header
  // contains the model dropdown trigger.
  await expect(page.getByText(/Asisten|Workspace/i).first()).toBeVisible({
    timeout: 15_000,
  });
}

export async function loginAsAdmin(page: Page) {
  return loginAs(page, ADMIN);
}

export async function loginAsMember(page: Page) {
  return loginAs(page, MEMBER);
}

export async function logout(page: Page) {
  await page.evaluate(() => {
    try { localStorage.removeItem('app:token'); } catch {}
  });
  await page.goto('/login');
}

/**
 * Send a chat message and wait for the assistant reply bubble to
 * land. Returns the assistant text for assertion.
 *
 * The composer textarea's placeholder is "Tulis pesan… tekan Enter
 * untuk kirim, Shift+Enter untuk baris baru" — match on partial text
 * to be locale-robust.
 */
export async function sendChatAndWaitForReply(
  page: Page,
  text: string,
  opts: { timeoutMs?: number } = {}
): Promise<string> {
  const { timeoutMs = REPLY_TIMEOUT } = opts;
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Send"]').first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill(text);
  // Composer Send button: a <button> containing the text "Send" plus
  // a <kbd> for the Enter shortcut. The accessible name is the
  // concatenated text content. Match with a contains-regex.
  const sendBtn = page.locator('button:has-text("Send"):not(:has-text("Sedang"))').last();
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });
  await sendBtn.click();

  // Wait for the TypingPill to disappear — it's the assistant bubble
  // whose only content is the streaming dots + "Sedang berpikir…" text.
  // The bubble has class "anim-slide-up" and contains an exact text
  // match for the spinner. The composer's textarea placeholder uses
  // the same text while streaming — match within the bubble, not the
  // whole page.
  const typingPill = page
    .locator('div.anim-slide-up:has-text("Sedang berpikir…")')
    .first();
  await expect(typingPill).toBeHidden({ timeout: timeoutMs });

  // The last assistant bubble carries the "Asisten" label and the
  // rendered markdown. Pull the bubble text.
  const lastAssistant = page
    .locator('div.anim-slide-up')
    .filter({ hasText: /^Asisten/ })
    .last();
  await expect(lastAssistant).toBeVisible({ timeout: 5_000 });
  return (await lastAssistant.textContent()) ?? '';
}

export async function newChat(page: Page) {
  await page.goto('/new');
  await page.waitForLoadState('networkidle');
}

/**
 * Attach a file by setting the hidden <input type="file"> in the
 * composer. The composer has a file picker button that opens a
 * native dialog; we bypass it by going straight to the input.
 */
export async function attachFile(page: Page, filePath: string) {
  // The composer mounts a hidden <input type="file">. We set files
  // directly. Multiple inputs may exist (one for camera capture) —
  // pick the one with `accept` not restricted to images.
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(filePath);
  // Wait for the attachment tile to render in the composer's strip.
  await page.waitForTimeout(500);
}
