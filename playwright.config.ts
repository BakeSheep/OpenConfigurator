import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  fullyParallel: false,
  // Demo telemetry includes WebGL charts; limiting concurrency keeps axe
  // analysis deterministic on both local machines and 2-core CI runners.
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  outputDir: 'test-results/playwright',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    // Capture a trace only for CI's retry. Persisting a full first-attempt
    // WebGL trace made local failures slow to tear down without adding signal.
    trace: 'on-first-retry',
  },
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER ? undefined : {
    // Launch Vite directly so Playwright owns a single process on Windows and
    // can reliably tear it down after the suite.
    command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/?demo=1#/dashboard',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'compact', use: { viewport: { width: 1024, height: 768 } } },
  ],
})
