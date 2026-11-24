import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests of the desktop app: Playwright starts the built app (`npm run build` first) as
 * `npm start` does, or the packaged app when HINDSIGHT_DESKTOP_APP names its executable. One test
 * at a time: each opens a real window, and the clipboard needs that window to have the focus.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  expect: { timeout: 15_000 },
})
