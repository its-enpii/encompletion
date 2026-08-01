import { test, expect } from '@playwright/test';
import { loginAsMember } from '../fixtures/ui';

test('sidebar uses one full/hidden toggle on tablet and desktop', async ({ page }) => {
  await loginAsMember(page);
  for (const width of [800, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/new');
    const sidebar = page.locator('[data-sidebar-mode]');
    await expect(sidebar).toHaveAttribute('data-sidebar-mode', 'full');
    const toggle = page.getByRole('button', { name: 'Toggle sidebar' }).first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(sidebar).toHaveAttribute('data-sidebar-mode', 'hidden');
    await toggle.click();
    await expect(sidebar).toHaveAttribute('data-sidebar-mode', 'full');
    await expect(page.getByRole('button', { name: /Collapse sidebar|Expand sidebar|Show sidebar/ })).toHaveCount(0);
  }
});

test('mobile hamburger opens drawer and close button dismisses it', async ({ page }) => {
  await loginAsMember(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new');
  const sidebar = page.locator('[data-sidebar-mode="full"]');
  await expect(sidebar).toHaveClass(/-translate-x-full/);
  await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();
  await expect(sidebar).toHaveClass(/translate-x-0/);
  await page.getByRole('button', { name: 'Close sidebar' }).click();
  await expect(sidebar).toHaveClass(/-translate-x-full/);
});

test('legacy mini preference migrates to full', async ({ page }) => {
  await loginAsMember(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/new');
  await page.evaluate(() => localStorage.setItem('app-shell:sidebar-mode', 'mini'));
  await page.reload();
  await expect(page.locator('[data-sidebar-mode]')).toHaveAttribute('data-sidebar-mode', 'full');
});
