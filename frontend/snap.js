const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login first
  await page.goto('http://localhost:8010/login', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'F:/Workspace/Enpii Studio/projects/encompletion/snap-login.png' });

  // Fill login form
  await page.fill('input[required]:first-of-type', 'admin');
  await page.fill('input[type="password"]', 'admin12345');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/new', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'F:/Workspace/Enpii Studio/projects/encompletion/snap-new.png' });

  // Navigate to Projects via sidebar
  const projectsLink = page.locator('a[href="/projects"]').first();
  if (await projectsLink.count() > 0) {
    await projectsLink.click();
    await page.waitForURL('**/projects', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'F:/Workspace/Enpii Studio/projects/encompletion/snap-projects.png' });
  }

  // Open New Project dialog
  const newBtn = page.locator('button:has-text("New project")').first();
  if (await newBtn.count() > 0) {
    await newBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'F:/Workspace/Enpii Studio/projects/encompletion/snap-projects-dialog.png' });
    await page.keyboard.press('Escape');
  }

  // Navigate to Users
  const usersLink = page.locator('a[href="/users"]').first();
  if (await usersLink.count() > 0) {
    await usersLink.click();
    await page.waitForURL('**/users', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'F:/Workspace/Enpii Studio/projects/encompletion/snap-users.png' });
  }

  await browser.close();
  console.log('Screenshots done');
})();