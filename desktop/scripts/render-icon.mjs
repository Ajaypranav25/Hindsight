// Renders the app icon, editors/vscode/icon.svg (the studio's mark), with a transparent background:
//
//   build/icon.png              1024x1024: electron-builder makes the Windows .ico and the macOS
//                               .icns from it, and it is the Linux window icon (dist/icon.png)
//   build/icons/<n>x<n>.png     the Linux icon set, 16 to 512, each size drawn from the SVG rather
//                               than scaled down, named as electron-builder expects
//
// Run `npm run icon` after changing the SVG; it drives the installed Google Chrome through
// Playwright (the repository's own dependency).
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const APP_ICON_SIZE = 1024
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktop, '..', 'editors', 'vscode', 'icon.svg')
const build = resolve(desktop, 'build')
const icons = join(build, 'icons')

const svg = readFileSync(source, 'utf8')

function pageOf(size) {
  return `<!doctype html>
<html><head><style>
  html, body { margin: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style></head><body>${svg}</body></html>`
}

const targets = [
  { size: APP_ICON_SIZE, path: join(build, 'icon.png') },
  ...LINUX_ICON_SIZES.map((size) => ({ size, path: join(icons, `${size}x${size}.png`) })),
]

mkdirSync(icons, { recursive: true })
const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' })
try {
  for (const { size, path } of targets) {
    const tab = await browser.newPage({ viewport: { width: size, height: size } })
    await tab.setContent(pageOf(size))
    await tab.locator('svg').screenshot({ path, omitBackground: true })
    await tab.close()
    console.log(`Wrote ${path}`)
  }
} finally {
  await browser.close()
}
