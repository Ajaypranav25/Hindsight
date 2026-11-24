// Renders the app icon, editors/vscode/icon.svg (the studio's mark), to build/icon.png at
// 1024x1024 with a transparent background. electron-builder makes the Windows .ico, the macOS
// .icns and the Linux sizes from that PNG. Run `npm run icon` after changing the SVG; it drives
// the installed Google Chrome through Playwright (the repository's own dependency).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const SIZE = 1024
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktop, '..', 'editors', 'vscode', 'icon.svg')
const target = resolve(desktop, 'build', 'icon.png')

const svg = readFileSync(source, 'utf8')
const page = `<!doctype html>
<html><head><style>
  html, body { margin: 0; background: transparent; }
  svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
</style></head><body>${svg}</body></html>`

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
try {
  const tab = await browser.newPage({ viewport: { width: SIZE, height: SIZE } })
  await tab.setContent(page)
  await tab.locator('svg').screenshot({ path: target, omitBackground: true })
  console.log(`Wrote ${target}`)
} finally {
  await browser.close()
}
