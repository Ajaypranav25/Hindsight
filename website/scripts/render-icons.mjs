// Renders the charms the page shows as small icons, and a still of the hero for browsers without
// WebGL, into public/icons and public/media:
//
//   npm run icons
//
// It starts the Vite dev server and screenshots render.html (one charm on a transparent canvas)
// and the hero in the installed Chrome, through the repository's Playwright.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = createRequire(join(site, '..', 'package.json'))('@playwright/test')
const KINDS = ['icon', 'rewind', 'braces', 'hourglass', 'loop', 'beads']
const PORT = 5181

async function waitForServer(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`the dev server did not start at ${url}`)
}

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: site,
  shell: process.platform === 'win32',
  stdio: 'ignore',
})
try {
  const base = `http://localhost:${PORT}`
  await waitForServer(base)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const icons = join(site, 'public', 'icons')
  mkdirSync(icons, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  for (const kind of KINDS) {
    await page.goto(`${base}/render.html?charm=${kind}`)
    await page.waitForFunction(() => globalThis.charmReady === true)
    await page
      .locator('#charm')
      .screenshot({ path: join(icons, `${kind}.png`), omitBackground: true })
    console.log(`icons/${kind}.png`)
  }
  const hero = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await hero.emulateMedia({ reducedMotion: 'reduce' })
  await hero.goto(base)
  await hero.waitForTimeout(1500)
  const still = join(site, 'public', 'media', 'hero-still.png')
  await hero.locator('[data-hero-canvas]').screenshot({ path: still, omitBackground: true })
  await browser.close()
  // WebP keeps the transparency at a fraction of the size.
  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      still,
      '-q:v',
      '82',
      join(site, 'public', 'media', 'hero-still.webp'),
    ],
    { stdio: 'inherit' },
  )
  rmSync(still)
  console.log('media/hero-still.webp')
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'])
  else server.kill('SIGTERM')
}
