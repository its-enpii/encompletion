import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the e2e suite.
 *
 * Base URL is read from $E2E_BASE_URL so the same image can target
 * different stacks (nginx in compose, a local host port, a staging
 * server). When unset, fall back to the in-compose hostname.
 *
 * Why serial workers: real LLM calls. Two parallel suites would race
 * for the same model and slow each other down. The total runtime is
 * bottlenecked by LLM latency, not by Playwright overhead.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://nginx:80',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // Real LLM traffic — generous default. Individual tests can
    // override via test.setTimeout(). The global 2min is enough for
    // the longest single send (image + text + reasoning).
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
