import { defineConfig } from '@playwright/test'

/**
 * Browser e2e of the web2 client (plan 20261015-testmyagent-web2-client, task T13).
 * It tests the DEPLOYED site (default https://testmyagent.com), not a local build.
 *
 * Environment (values are never printed; CI passes them as masked secrets):
 *   E2E_WEB2_URL        site origin (default production)
 *   E2E_DFL_EMAIL       DFL smoke user e-mail      (CLAUDE_SMOKE_USERNAME)
 *   E2E_DFL_PASSWORD    DFL smoke user password    (CLAUDE_SMOKE_PASSWORD)
 *   E2E_OPENROUTER_KEY  capped OpenRouter key for the free run (free-run.spec.ts only)
 *   E2E_MODEL           model id for the free run (default deepseek/deepseek-v4.1-flash, the cheapest in /models)
 *   E2E_TASK_NAME       task name to pick (default "Duplicate settlement webhook")
 *   E2E_CHROME          path of a Chrome binary (default: Playwright's Chromium)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The two specs share one smoke user and its daily quota: run them one after the other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A free run takes about 6 minutes; the spec waits up to 15.
  timeout: 20 * 60 * 1000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'report/results.json' }], ['html', { outputFolder: 'report/html', open: 'never' }]],
  outputDir: 'report/artifacts',
  use: {
    baseURL: process.env.E2E_WEB2_URL || 'https://testmyagent.com',
    // No trace and no video: the specs type a password and an API key.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: process.env.E2E_CHROME ? { executablePath: process.env.E2E_CHROME } : {},
  },
})
