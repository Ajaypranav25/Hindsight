/**
 * Files and links the app is started with: what Explorer, Finder, a file manager or a browser's
 * hindsight:// link hands it. They wait until the studio is ready for them.
 *
 * Until the studio drives the bridge itself (src/studio/desktop/connect.ts), these tests play the
 * studio's part: they subscribe and call ready(). Once it does, the studio's own listener takes
 * the launch requests, and the tests check what it shows instead.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { editorContent } from '../../e2e/fixtures'
import { appLink } from '../../src/studio/desktop/bridge'
import {
  closeApp,
  launchApp,
  listenOnBridge,
  received,
  STUDIO_CONNECTED,
  waitForStudio,
  windowTitle,
  type DesktopApp,
} from './app'

const PROGRAM = 'let launched = 6 * 7\nprint("launched {launched}")\n'
const LINKED = 'print("from a link")\n'

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

async function start(args: readonly string[], cwd?: string): Promise<Page> {
  desktop = await launchApp({ args, cwd })
  await waitForStudio(desktop.page)
  return desktop.page
}

test.describe('before the studio subscribes itself', () => {
  test.skip(STUDIO_CONNECTED, 'the studio takes launch requests itself; see the tests below')

  test('a .sight file waits for ready() and arrives as a program', async () => {
    // Arrange
    const path = programFile()

    // Act
    const page = await start([path])
    await listenOnBridge(page)

    // Assert
    await expect
      .poll(() => received(page))
      .toEqual([{ kind: 'program', source: PROGRAM, path, name: 'launched.sight' }])
  })

  test('a relative path is found from the folder the app was started in', async () => {
    // Arrange
    const path = programFile('relative.sight')

    // Act
    const page = await start(['relative.sight'], folder)
    await listenOnBridge(page)

    // Assert
    await expect.poll(() => received(page)).toEqual([expect.objectContaining({ path })])
  })

  // Electron refuses to start when anything follows a URL on its command line (so a crafted link
  // cannot smuggle in switches), and the system passes one link at a time: one link per launch.
  test('a hindsight:// link arrives as a link', async () => {
    // Arrange
    const link = appLink(LINKED, 5)!

    // Act
    const page = await start([link])
    await listenOnBridge(page)

    // Assert
    await expect
      .poll(() => received(page))
      .toEqual([{ kind: 'link', fragment: link.slice(link.indexOf('#')) }])
  })

  test('a link that is not a program link is ignored', async () => {
    // Act
    const page = await start(['hindsight://open/#other=1'])
    await listenOnBridge(page)

    // Assert: nothing arrives, and the studio carries on with its own program.
    await page.waitForTimeout(1_000)
    expect(await received(page)).toEqual([])
    await waitForStudio(page)
  })

  test('a .sighttrace file arrives as bytes for the studio to check', async () => {
    // Arrange
    const path = join(folder, 'run.sighttrace')
    writeFileSync(path, Buffer.from('SIGHTTRC not really a trace'))

    // Act
    const page = await start([path])
    await listenOnBridge(page)

    // Assert
    await expect
      .poll(() => received(page))
      .toEqual([
        {
          kind: 'trace',
          name: 'run.sighttrace',
          bytes: [...Buffer.from('SIGHTTRC not really a trace')],
        },
      ])
  })
})

test.describe('once the studio subscribes itself', () => {
  test.skip(
    !STUDIO_CONNECTED,
    'needs the studio side of the bridge (src/studio/desktop/connect.ts)',
  )

  test('a .sight file opens in the editor and names the window', async () => {
    // Arrange
    const path = programFile()

    // Act
    const page = await start([path])

    // Assert
    await expect(editorContent(page)).toContainText('print("launched {launched}")')
    await expect.poll(() => windowTitle(desktop!.app)).toBe('launched.sight — Hindsight')
  })

  test('a hindsight:// link opens its program in the editor', async () => {
    // Act
    const page = await start([appLink(LINKED, null)!])

    // Assert
    await expect(editorContent(page)).toContainText('print("from a link")')
  })
})
