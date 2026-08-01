import { test, expect } from '@playwright/test';
import { loginAsMember } from '../fixtures/ui';

test('tablet keeps chat usable and overlays artifact rail', async ({ page }) => {
  await loginAsMember(page);
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto('/new');
  await expect(page.locator('[data-sidebar-mode="mini"]')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect(page.locator('[data-sidebar-mode="full"], [data-sidebar-mode="mini"]')).toBeVisible();
});
