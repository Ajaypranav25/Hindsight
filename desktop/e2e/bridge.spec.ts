/**
 * The DesktopBridge as the studio sees it (window.hindsightDesktop): saving, driven from the page
 * the way src/studio/desktop/connect.ts drives it, and the menus' commands and open requests, which
 * a listener beside the studio's own records as the studio acts on them.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { editorContent } from '../../e2e/fixtures'
import { appLink } from '../../src/studio/desktop/bridge'
import { MENU_IDS } from '../src/menu-template'
import {
  APP_VERSION,
  closeApp,
  clickMenu,
  launchApp,
  launchSecondInstance,
  listenOnBridge,
  received,
  recorded,
  stubOpenDialog,
  stubSaveDialog,
  waitForStudio,
  windowTitle,
  type BridgeWindow,
  type DesktopApp,
} from './app'

let desktop: DesktopApp
let folder: string

test.beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'hindsight-desktop-files-'))
  desktop = await launchApp()
  await waitForStudio(desktop.page)
})

test.afterEach(async () => {
  await closeApp(desktop)
})

function save(source: unknown, path: string | null) {
  return desktop.page.evaluate(
    ([text, file]) =>
      (window as unknown as BridgeWindow).hindsightDesktop.saveProgram({
        source: text as string,
        path: file,
      }),
    [source, path] as const,
  )
}

test('window.hindsightDesktop is the whole contract, and frozen', async () => {
  // Act
  const shape = await desktop.page.evaluate(() => {
    const bridge = (window as unknown as BridgeWindow).hindsightDesktop
    return {
      types: Object.fromEntries(Object.entries(bridge).map(([key, value]) => [key, typeof value])),
      platform: bridge.platform,
      version: bridge.version,
      frozen: Object.isFrozen(bridge),
    }
  })

  // Assert
  expect(shape).toEqual({
    types: {
      platform: 'string',
      version: 'string',
      onOpen: 'function',
      onCommand: 'function',
      saveProgram: 'function',
      setDocument: 'function',
      ready: 'function',
    },
    platform: process.platform,
    version: APP_VERSION,
    frozen: true,
  })
})

test('saveProgram asks where to save a new program, then saves there without asking', async () => {
  // Arrange
  const target = join(folder, 'saved.sight')
  await stubSaveDialog(desktop.app, target)

  // Act
  const first = await save('print(1)\n', null)
  const again = await save('print(2)\n', target)

  // Assert
  expect(first).toEqual({ ok: true, path: target, name: 'saved.sight' })
  expect(again).toEqual(first)
  expect(readFileSync(target, 'utf8')).toBe('print(2)\n')
  const asked = await recorded(desktop.app, 'save')
  expect(asked).toHaveLength(1)
  expect(String(asked[0])).toMatch(/program\.sight$/)
})

test('saveProgram asks before writing to a file the user never chose', async () => {
  // Arrange: the page names a file this session did not open or save.
  const unknown = join(folder, 'elsewhere.sight')
  await stubSaveDialog(desktop.app, null)

  // Act
  const result = await save('print(3)\n', unknown)

  // Assert: the Save dialog suggested it; the user cancelled, so nothing was written.
  expect(result).toEqual({ ok: false, reason: 'cancelled' })
  expect(await recorded(desktop.app, 'save')).toEqual([unknown])
  expect(() => readFileSync(unknown)).toThrow()
})

test('saveProgram reports a write that fails, and refuses a malformed request', async () => {
  // Arrange
  await stubSaveDialog(desktop.app, join(folder, 'missing-folder', 'x.sight'))

  // Act
  const failed = await save('print(4)\n', null)
  const malformed = await save(42, null)

  // Assert
  expect(failed).toMatchObject({ ok: false, reason: 'failed' })
  expect((failed as { message: string }).message).toBe(
    'x.sight could not be saved because it does not exist.',
  )
  expect(malformed).toMatchObject({ ok: false, reason: 'failed' })
})

test('the File menu sends New, Save and Save As to the studio', async () => {
  // Arrange: a cancelled Save dialog, should anything ask.
  await stubSaveDialog(desktop.app, null)
  await listenOnBridge(desktop.page)

  // Act
  for (const id of [MENU_IDS.new, MENU_IDS.save, MENU_IDS.saveAs]) await clickMenu(desktop.app, id)

  // Assert: the studio emptied the editor, and both saves asked for a file (and were cancelled).
  await expect
    .poll(() => received(desktop.page))
    .toEqual([{ command: 'new' }, { command: 'save' }, { command: 'save-as' }])
  await expect(editorContent(desktop.page)).toHaveText('')
  await expect.poll(() => recorded(desktop.app, 'save')).toHaveLength(2)
  expect(await windowTitle(desktop.app)).toBe('Hindsight')
})

test('File > Open reads the chosen program and hands it to the studio', async () => {
  // Arrange
  const path = join(folder, 'opened.sight')
  writeFileSync(path, 'print("opened")\n')
  await stubOpenDialog(desktop.app, [path])
  await listenOnBridge(desktop.page)

  // Act
  await clickMenu(desktop.app, MENU_IDS.open)

  // Assert
  await expect
    .poll(() => received(desktop.page))
    .toEqual([{ kind: 'program', source: 'print("opened")\n', path, name: 'opened.sight' }])
  await expect(editorContent(desktop.page)).toContainText('print("opened")')
  await expect.poll(() => windowTitle(desktop.app)).toBe('opened.sight — Hindsight')
})

test('an opened program may be saved over, an opened trace never', async () => {
  // Arrange
  const program = join(folder, 'mine.sight')
  const trace = join(folder, 'run.sighttrace')
  writeFileSync(program, 'print("old")\n')
  writeFileSync(trace, 'SIGHTTRC')
  await stubSaveDialog(desktop.app, null)
  await listenOnBridge(desktop.page)
  for (const path of [program, trace]) {
    await stubOpenDialog(desktop.app, [path])
    await clickMenu(desktop.app, MENU_IDS.open)
  }
  await expect.poll(async () => (await received(desktop.page)).length).toBe(2)

  // Act
  const overProgram = await save('print("new")\n', program)
  const overTrace = await save('print("new")\n', trace)

  // Assert: the trace's path only got a Save dialog, which the user cancelled.
  expect(overProgram).toEqual({ ok: true, path: program, name: 'mine.sight' })
  expect(readFileSync(program, 'utf8')).toBe('print("new")\n')
  expect(overTrace).toEqual({ ok: false, reason: 'cancelled' })
  expect(readFileSync(trace, 'utf8')).toBe('SIGHTTRC')
  expect(await recorded(desktop.app, 'save')).toEqual([trace])
})

test('a second launch hands its file and link to the running app and exits', async () => {
  // Arrange
  const path = join(folder, 'second.sight')
  writeFileSync(path, 'print("second")\n')
  const link = appLink('print("linked")\n', 3)!
  await listenOnBridge(desktop.page)

  // Act
  const exitCode = await launchSecondInstance(desktop.userDataDir, [path, link])

  // Assert
  expect(exitCode).toBe(0)
  await expect
    .poll(() => received(desktop.page))
    .toEqual([
      { kind: 'program', source: 'print("second")\n', path, name: 'second.sight' },
      { kind: 'link', fragment: link.slice(link.indexOf('#')) },
    ])
  // The studio opened both, in order: the link's program, of no file, is the one left.
  await expect(editorContent(desktop.page)).toContainText('print("linked")')
  await expect.poll(() => windowTitle(desktop.app)).toBe('Hindsight')
})
