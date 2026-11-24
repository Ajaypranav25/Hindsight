/**
 * Files and links the app is started with: what Explorer, Finder, a file manager or a browser's
 * hindsight:// link hands it. They wait until the studio has subscribed to the bridge and called
 * ready(), then open in the studio.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { editorContent, penStep, waitForRun } from '../../e2e/fixtures'
import { compile, encodeTraceFileSync, record, traceBundle } from '../../src/core/index'
import { appLink } from '../../src/studio/desktop/bridge'
import {
  APP_VERSION,
  closeApp,
  launchApp,
  notice,
  waitForStudio,
  watchNotices,
  windowTitle,
  type DesktopApp,
} from './app'

const PROGRAM = 'let launched = 6 * 7\nprint("launched {launched}")\n'
const LINKED = 'var total = 1\ntotal = total + 2\ntotal = total + 3\nprint("linked {total}")\n'
const TRACED = 'var steps = 0\nsteps = steps + 1\nsteps = steps + 1\nprint("traced {steps}")\n'

let folder: string
let desktop: DesktopApp | undefined

test.beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'hindsight-desktop-launch-'))
})

test.afterEach(async () => {
  await closeApp(desktop)
  desktop = undefined
})

function programFile(name = 'launched.sight', source = PROGRAM): string {
  const path = join(folder, name)
  writeFileSync(path, source)
  return path
}

/** A real trace of `source`, with the pen at step `time`, as `hindsight record` writes one. */
function traceFile(name: string, source: string, time: number): string {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(`the traced program does not compile: ${source}`)
  const bundle = traceBundle({
    recording: record(compiled.program),
    time,
    hindsightVersion: APP_VERSION,
    title: name.replace(/\.sighttrace$/, ''),
  })
  if (!bundle.ok) throw new Error(bundle.error)
  const encoded = encodeTraceFileSync(bundle.bundle)
  if (!encoded.ok) throw new Error(encoded.error)
  const path = join(folder, name)
  writeFileSync(path, encoded.bytes)
  return path
}

/** Starts the app with `args` and waits for the studio's page (not for any run). */
async function start(args: readonly string[], cwd?: string): Promise<Page> {
  desktop = await launchApp({ args, cwd })
  await expect(desktop.page.locator('#root')).not.toBeEmpty()
  return desktop.page
}

test('a .sight file opens in the editor and names the window', async () => {
  // Arrange
  const path = programFile()

  // Act
  const page = await start([path])

  // Assert
  await expect(editorContent(page)).toContainText('print("launched {launched}")')
  await expect.poll(() => windowTitle(desktop!.app)).toBe('launched.sight — Hindsight')
  await waitForRun(page, /Finished/)
})

test('a relative path is found from the folder the app was started in', async () => {
  // Arrange
  programFile('relative.sight', 'print("relative")\n')

  // Act
  const page = await start(['relative.sight'], folder)

  // Assert
  await expect(editorContent(page)).toContainText('print("relative")')
  await expect.poll(() => windowTitle(desktop!.app)).toBe('relative.sight — Hindsight')
})

// Electron refuses to start when anything follows a URL on its command line (so a crafted link
// cannot smuggle in switches), and the system passes one link at a time: one link per launch.
test('a hindsight:// link opens its program in the editor, at its step', async () => {
  // Act
  const page = await start([appLink(LINKED, 3)!])
  const notices = await watchNotices(page)

  // Assert: the program belongs to no file, so the window keeps the app's name.
  await expect(editorContent(page)).toContainText('print("linked {total}")')
  await waitForRun(page, /Finished/)
  await expect.poll(() => penStep(page)).toBe(3)
  expect(await windowTitle(desktop!.app)).toBe('Hindsight')
  expect(await notices()).toEqual([])
})

const NOT_OPENED = 'print("not opened")\n'
const IGNORED_LINKS: readonly (readonly [string, string])[] = [
  ['a link without a program', 'hindsight://open/#other=1'],
  ['a program that does not decode', 'hindsight://open/#src=not~a~program'],
  ['a link to anything but open', appLink(NOT_OPENED, null)!.replace('//open', '//run')],
  ['a link with a query', appLink(NOT_OPENED, null)!.replace('/#', '/?x=1#')],
]

for (const [what, link] of IGNORED_LINKS) {
  test(`a link that is not a program link is ignored: ${what}`, async () => {
    // Act
    const page = await start([link])
    const notices = await watchNotices(page)

    // Assert: the studio starts on its own program, with nothing to report.
    await waitForStudio(page)
    await expect(editorContent(page)).not.toBeEmpty()
    await expect(editorContent(page)).not.toContainText('not opened')
    expect(await notices()).toEqual([])
    expect(await windowTitle(desktop!.app)).toBe('Hindsight')
  })
}

test('a .sighttrace file opens its run in the studio, at its step', async () => {
  // Arrange
  const path = traceFile('traced.sighttrace', TRACED, 2)

  // Act
  const page = await start([path])

  // Assert: the trace's program, recorded again and checked, with the pen where it was saved.
  await expect(editorContent(page)).toContainText('print("traced {steps}")')
  await expect(notice(page)).toHaveText('Opened “traced” at step 2.')
  expect(await penStep(page)).toBe(2)
  expect(await windowTitle(desktop!.app)).toBe('Hindsight')
})

test('a .sighttrace file that is not a trace leaves the program and says why', async () => {
  // Arrange
  const path = join(folder, 'broken.sighttrace')
  writeFileSync(path, Buffer.from('SIGHTTRC not really a trace'))

  // Act
  const page = await start([path])
  const notices = await watchNotices(page)

  // Assert
  await expect(notice(page)).toContainText('Could not open the trace:')
  expect(await notices()).toEqual([expect.stringMatching(/^Could not open the trace: /)])
  await expect(editorContent(page)).not.toBeEmpty()
  await expect(editorContent(page)).not.toContainText('SIGHTTRC')
  expect(await windowTitle(desktop!.app)).toBe('Hindsight')
})
