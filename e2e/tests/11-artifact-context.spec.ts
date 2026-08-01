import { test, expect } from '@playwright/test';
import { loginAsMember } from '../fixtures/ui';

test('ordinary fenced code stays in chat', async ({ page }) => {
  await loginAsMember(page);
  await page.goto('/new');
  const composer = page.locator('textarea[placeholder*="Tulis pesan"], textarea[placeholder*="Pesan"]').first();
  await composer.fill('Explain a short JavaScript example with a fenced code block.');
  await page.getByRole('button', { name: /Send/i }).last().click();
  await expect(page.locator('text=Sedang berpikir…')).toBeHidden({ timeout: 90_000 });
  await expect(page.locator('button[title*="Buka panel artifact"]')).toBeVisible();
});
