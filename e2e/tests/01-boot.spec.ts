/**
 * Test 01: boot, login, logout, auth gate, sidebar.
 *
 * Validates the foundation every other test depends on: the auth
 * flow, sidebar session list, and route guard. Runs as a smoke before
 * any chat interaction.
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, loginAsMember, logout } from '../fixtures/ui';

test('boots, shows login, logs in as admin, sees sidebar', async ({ page }) => {
  await page.goto('/');
  // Auth gate redirects unauthenticated users to /login.
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  await expect(page.getByLabel(/username/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();

  await loginAsAdmin(page);

  // Sidebar should render the brand + a "New chat" affordance.
  await expect(page.locator('aside, nav, [data-sidebar]').first()).toBeVisible();
  // Chat header should be visible — model picker or session title.
  await expect(page.locator('header').first()).toBeVisible();
});

test('rejects invalid credentials with a clear error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/username/i).fill('admin');
  await page.getByLabel(/password/i).fill('definitely-wrong-password');
  await page.getByRole('button', { name: /masuk|log\s*in|sign\s*in/i }).click();
  // Error message renders inline; assert it appears.
  await expect(page.getByText(/invalid|gagal|salah|credential/i).first()).toBeVisible({
    timeout: 5_000,
  });
});

test('auth gate bounces unauthenticated access to /login', async ({ page }) => {
  await page.goto('/new');
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  // ?next= param preserves where we were going.
  expect(page.url()).toMatch(/next=/);
});

test('logout clears the session and returns to login', async ({ page }) => {
  await loginAsMember(page);
  await logout(page);
  await expect(page.getByLabel(/username/i)).toBeVisible();
  // Visiting a protected page after logout should bounce back.
  await page.goto('/new');
  await page.waitForURL(/\/login/, { timeout: 10_000 });
});
