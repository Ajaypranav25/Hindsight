/**
 * Records the README's demo GIF (docs/images/demo.gif): the linked-list example, with the pen
 * stepping backwards through `reversed` while the heap graph rewires its arrows, then forwards
 * again so the loop is seamless. Run with
 *
 *   npx tsx scripts/demo-gif.ts [--port 5175] [--out docs/images/demo.gif] [--keep-frames]
 *
 * It starts the Vite dev server, drives the studio in the installed Chrome with Playwright,
 * screenshots one frame per step and assembles them with ffmpeg (palettegen + paletteuse).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { compile, record } from '../src/core/index'

const EXAMPLE = 'examples/15-linked-list.sight'
const VIEWPORT = { width: 1440, height: 900 }
const WIDTH = 960
const STEP_MS = 230
const HOLD_FRAMES = 6

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback
}

/** The steps that bracket the reversal loop: a moment just after it, and its first statement. */
function reversalWindow(source: string): { readonly after: number; readonly first: number } {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('the example does not compile')
  const recording = record(compiled.program)
  const lines = source.split('\n')
  const lineOf = (text: string) => lines.findIndex((line) => line.trim() === text) + 1
  const following = recording.lineHits(lineOf('let following = current.next'))
  const result = recording.lineHits(lineOf('previous'))
  if (following.length === 0 || result.length === 0) throw new Error('unexpected example shape')
  return { first: following[0]!, after: result[result.length - 1]! }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 300))
  }
  throw new Error(`the dev server did not start at ${url}`)
}

function startServer(port: number): ChildProcess {
  return spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    shell: process.platform === 'win32',
    stdio: 'ignore',
  })
}

function stopServer(server: ChildProcess): void {
  if (server.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'])
  else server.kill('SIGTERM')
}

async function penStep(page: Page): Promise<number> {
  const label =
    (await page.getByRole('slider', { name: 'Time' }).getAttribute('aria-valuenow')) ?? ''
  return Number(label)
}

async function captureFrames(page: Page, dir: string, first: number): Promise<number> {
  let frame = 0
  const shot = async () => {
    await page.screenshot({ path: join(dir, `frame-${String(frame++).padStart(4, '0')}.png`) })
  }
  const chart = page.getByRole('slider', { name: 'Time' })
  await chart.focus()
  for (let i = 0; i < HOLD_FRAMES; i++) await shot()
  const forwards: number[] = []
  while ((await penStep(page)) >= first) {
    forwards.push(await penStep(page))
    await chart.press('ArrowLeft')
    await page.waitForTimeout(STEP_MS)
    await shot()
  }
  for (let i = 0; i < HOLD_FRAMES; i++) await shot()
  for (let i = 0; i < forwards.length; i++) {
    await chart.press('ArrowRight')
    await page.waitForTimeout(STEP_MS)
    await shot()
  }
  return frame
}

function assemble(dir: string, out: string, fps: number): void {
  const palette = join(dir, 'palette.png')
  const input = join(dir, 'frame-%04d.png')
  const scale = `scale=${WIDTH}:-1:flags=lanczos`
  const run = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
  }
  run([
    '-framerate',
    String(fps),
    '-i',
    input,
    '-vf',
    `${scale},palettegen=stats_mode=diff`,
    palette,
  ])
  run([
    '-framerate',
    String(fps),
    '-i',
    input,
    '-i',
    palette,
    '-lavfi',
    `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop',
    '0',
    out,
  ])
}

async function main(): Promise<void> {
  const port = Number(option('--port', '5175'))
  const out = resolve(option('--out', 'docs/images/demo.gif'))
  const source = readFileSync(EXAMPLE, 'utf8')
  const { first, after } = reversalWindow(source)
  const dir = mkdtempSync(join(tmpdir(), 'hindsight-gif-'))
  mkdirSync(dir, { recursive: true })
  const server = startServer(port)
  try {
    const base = `http://localhost:${port}`
    await waitForServer(base, 60_000)
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: 'light' })
    await page.addInitScript(() => {
      try {
        window.localStorage.clear()
      } catch {
        // The studio works without storage.
      }
    })
    const fragment = `#src=${Buffer.from(source).toString('base64url')}&t=${after}`
    await page.goto(`${base}/${fragment}`)
    await page
      .locator('.ch-status-line')
      .getByText(/Finished/)
      .waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Dismiss hint' }).click()
    // Give the heap graph the instrument column: the call stack has nothing to show here.
    await page.getByRole('button', { name: 'Call stack', exact: true }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Fit graph to panel' }).click()
    await page.waitForTimeout(800)
    const frames = await captureFrames(page, dir, first)
    await browser.close()
    assemble(dir, out, Math.round(1000 / STEP_MS))
    const kb = Math.round(statSync(out).size / 1024)
    process.stdout.write(`${frames} frames -> ${out} (${kb} KB)\n`)
  } finally {
    stopServer(server)
    if (!process.argv.includes('--keep-frames')) rmSync(dir, { recursive: true, force: true })
    else process.stdout.write(`frames kept in ${dir}\n`)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
