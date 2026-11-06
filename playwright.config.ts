import { defineConfig } from '@playwright/test'

/** E2E_PORT lets several checkouts (git worktrees) run their suites side by side. */
const PORT = Number(process.env.E2E_PORT ?? 5199)

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Locally, the installed Google Chrome saves a browser download; CI installs Playwright's own
    // Chromium (`npx playwright install --with-deps chromium`) so runs do not depend on the image.
    channel: process.env.CI ? undefined : 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
