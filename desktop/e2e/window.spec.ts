/**
 * The app's window: its title and the unsaved-changes prompt for the studio's program, File > New,
 * Save and Save As, View > Reload, where it opens, what it does with links to the web, and a
 * crashed page.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { editorContent, loadExample, replaceProgram } from '../../e2e/fixtures'
import { MENU_IDS } from '../src/menu-template'
import {
  clickMenu,
  closeApp,
  closeWindow,
  DESKTOP_DIR,
  launchApp,
  notice,
  recorded,
  stubMessageBox,
  stubOpenDialog,
  stubOpenExternal,
  stubSaveDialog,
  waitForStudio,
  windowCount,
  windowTitle,
  type DesktopApp,
} from './app'

const SAVED = 'let kept = 1\nprint("saved {kept}")\n'
const EDITED = 'let kept = 2\nprint("edited {kept}")\n'

let desktop: DesktopApp | undefined

test.afterEach(async () => {
  await closeApp(desktop)
  desktop = undefined
})

async function start(args: readonly string[] = [], userDataDir?: string): Promise<DesktopApp> {
  desktop = await launchApp({ args, userDataDir })
  await waitForStudio(desktop.page)
  return desktop
}

/** A program file in a folder of its own. */
function programFile(name: string, source = SAVED): string {
  const path = join(mkdtempSync(join(tmpdir(), 'hindsight-desktop-window-')), name)
  writeFileSync(path, source)
  return path
}

/** Starts the app with `path` open in the studio, unchanged. */
async function startWith(path: string): Promise<DesktopApp> {
  const started = await start([path])
  await expect(editorContent(started.page)).toContainText(
    readFileSync(path, 'utf8').split('\n')[0]!,
  )
  await expect.poll(() => windowTitle(started.app)).toBe(`${basename(path)} \u2014 Hindsight`)
  return started
}

/** Replaces the program as the user would, and waits for the app to see the change. */
async function edit(started: DesktopApp, source: string, title: string): Promise<void> {
  await replaceProgram(started.page, source)
  await expect.poll(() => windowTitle(started.app)).toBe(title)
}

/** Resolves when the app's window has closed. */
function closed(page: Page): Promise<unknown> {
  return page.waitForEvent('close', { timeout: 15_000 })
}

// --- the document: title and unsaved changes --------------------------------------------------

test('editing an opened file marks it unsaved, and undoing the edit unmarks it', async () => {
  // Arrange
  const started = await startWith(programFile('edited.sight'))
  const { app, page } = started

  // Act and assert: typed changes mark it.
  await edit(started, EDITED, '\u25cf edited.sight \u2014 Hindsight')

  // Act and assert: the editor's Undo takes the text back to the file's, which unmarks it.
  await editorContent(page).press('ControlOrMeta+z')
  await expect(editorContent(page)).toContainText('print("saved {kept}")')
  await expect.poll(() => windowTitle(app)).toBe('edited.sight \u2014 Hindsight')

  // Act and assert: typing the file's text back unmarks it too.
  await edit(started, EDITED, '\u25cf edited.sight \u2014 Hindsight')
  await edit(started, SAVED, 'edited.sight \u2014 Hindsight')
})

test('closing without unsaved changes does not ask', async () => {
  // Arrange
  const { app, page } = await startWith(programFile('clean.sight'))
  await stubMessageBox(app, 'Cancel')
  const gone = closed(page)

  // Act
  await closeWindow(app)

  // Assert: a prompt would have been answered Cancel, keeping the window open.
  await gone
})

test("closing with unsaved changes asks; Cancel keeps the window, Don't Save closes it", async () => {
  // Arrange
  const path = programFile('asked.sight')
  const started = await startWith(path)
  const { app, page } = started
  await edit(started, EDITED, '\u25cf asked.sight \u2014 Hindsight')
  await stubMessageBox(app, 'Cancel')

  // Act: Cancel.
  await closeWindow(app)

  // Assert
  await expect
    .poll(() => recorded(app, 'message'))
    .toEqual(['Do you want to save the changes you made to asked.sight?'])
  expect(await windowCount(app)).toBe(1)
  expect(await windowTitle(app)).toBe('\u25cf asked.sight \u2014 Hindsight')
  await expect(editorContent(page)).toContainText('print("edited {kept}")')

  // Act: Don't Save.
  await stubMessageBox(app, "Don't Save")
  const gone = closed(page)
  await closeWindow(app)

  // Assert
  await gone
  expect(readFileSync(path, 'utf8')).toBe(SAVED)
})

test('Save in the close prompt writes the edited program to its file, then closes', async () => {
  // Arrange: a Save dialog would be cancelled, keeping the window; the opened file needs none.
  const path = programFile('kept.sight')
  const started = await startWith(path)
  await edit(started, EDITED, '\u25cf kept.sight \u2014 Hindsight')
  await stubSaveDialog(started.app, null)
  await stubMessageBox(started.app, 'Save')
  const gone = closed(started.page)

  // Act
  await closeWindow(started.app)

  // Assert
  await gone
  expect(readFileSync(path, 'utf8')).toBe(EDITED)
})

test('a save that fails keeps the window open, and the studio says why', async () => {
  // Arrange: the file's folder disappears after the file was opened.
  const path = programFile('lost.sight')
  const started = await startWith(path)
  const { app, page } = started
  await edit(started, EDITED, '\u25cf lost.sight \u2014 Hindsight')
  rmSync(join(path, '..'), { recursive: true, force: true })
  await stubMessageBox(app, 'Save')

  // Act
  await closeWindow(app)

  // Assert
  await expect(notice(page)).toHaveText(
    'Could not save the program: lost.sight could not be saved because it does not exist.',
  )
  expect(await recorded(app, 'message')).toHaveLength(1)
  expect(await windowCount(app)).toBe(1)
  expect(await windowTitle(app)).toBe('\u25cf lost.sight \u2014 Hindsight')

  // Act and assert: closing again asks again, and the user may still let the changes go.
  await stubMessageBox(app, 'Cancel')
  await closeWindow(app)
  await expect.poll(() => recorded(app, 'message')).toHaveLength(1)
  expect(await windowCount(app)).toBe(1)
  await stubMessageBox(app, "Don't Save")
  const gone = closed(page)
  await closeWindow(app)
  await gone
  expect(existsSync(path)).toBe(false)
})

// --- File > Save As and File > New -------------------------------------------------------------

test('File > Save As writes a new file and names the window after it; Save then writes there', async () => {
  // Arrange
  const first = programFile('first.sight')
  const second = join(mkdtempSync(join(tmpdir(), 'hindsight-desktop-save-as-')), 'second.sight')
  const started = await startWith(first)
  const { app } = started
  await edit(started, EDITED, '\u25cf first.sight \u2014 Hindsight')
  await stubSaveDialog(app, second)

  // Act
  await clickMenu(app, MENU_IDS.saveAs)

  // Assert: the new file holds the edit; the opened one is untouched.
  await expect.poll(() => windowTitle(app)).toBe('second.sight \u2014 Hindsight')
  expect(readFileSync(second, 'utf8')).toBe(EDITED)
  expect(readFileSync(first, 'utf8')).toBe(SAVED)
  expect(await recorded(app, 'save')).toHaveLength(1)

  // Act: another edit, then File > Save.
  await edit(started, SAVED, '\u25cf second.sight \u2014 Hindsight')
  await clickMenu(app, MENU_IDS.save)

  // Assert: written to the chosen file without asking again.
  await expect.poll(() => windowTitle(app)).toBe('second.sight \u2014 Hindsight')
  expect(readFileSync(second, 'utf8')).toBe(SAVED)
  expect(await recorded(app, 'save')).toHaveLength(1)
})

test('File > New starts an empty program of no file; Save asks where to keep it', async () => {
  // Arrange
  const opened = programFile('opened.sight')
  const target = join(mkdtempSync(join(tmpdir(), 'hindsight-desktop-new-')), 'fresh.sight')
  const { app, page } = await startWith(opened)

  // Act
  await clickMenu(app, MENU_IDS.new)

  // Assert: an empty editor, and a window named after no file.
  await expect(editorContent(page)).toHaveText('')
  await expect.poll(() => windowTitle(app)).toBe('Hindsight')

  // Act: typed, the program still belongs to no file, so it is never marked unsaved.
  await replaceProgram(page, 'print("fresh")\n')
  await expect(editorContent(page)).toContainText('print("fresh")')
  await stubSaveDialog(app, target)
  await clickMenu(app, MENU_IDS.save)

  // Assert: Save asked for a file (suggesting a new one), wrote it, and named the window.
  await expect.poll(() => windowTitle(app)).toBe('fresh.sight \u2014 Hindsight')
  expect(readFileSync(target, 'utf8')).toBe('print("fresh")\n')
  expect(readFileSync(opened, 'utf8')).toBe(SAVED)
  const asked = await recorded(app, 'save')
  expect(asked).toHaveLength(1)
  expect(String(asked[0])).toMatch(/program\.sight$/)
})

test('a program the studio loads over a file leaves it, so Save never overwrites the file', async () => {
  // Arrange: a.sight edited, then b.sight opened over it from File > Open.
  const a = programFile('a.sight', 'print("a")\n')
  const b = programFile('b.sight', 'print("b")\n')
  const started = await startWith(a)
  const { app, page } = started
  await edit(started, 'print("a, edited")\n', '\u25cf a.sight \u2014 Hindsight')
  await stubOpenDialog(app, [b])
  await clickMenu(app, MENU_IDS.open)
  await expect(editorContent(page)).toContainText('print("b")')
  await expect.poll(() => windowTitle(app)).toBe('b.sight \u2014 Hindsight')
  await stubSaveDialog(app, null)

  // Act: Restore brings a.sight's edits back, then Save.
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(editorContent(page)).toContainText('print("a, edited")')
  await clickMenu(app, MENU_IDS.save)

  // Assert: the edits are no file's, so Save asked for one (and was cancelled).
  await expect.poll(() => recorded(app, 'save')).toHaveLength(1)
  expect(await windowTitle(app)).toBe('Hindsight')
  expect(readFileSync(b, 'utf8')).toBe('print("b")\n')

  // Act: a gallery example over a file opened again.
  await stubOpenDialog(app, [b])
  await clickMenu(app, MENU_IDS.open)
  await expect.poll(() => windowTitle(app)).toBe('b.sight \u2014 Hindsight')
  await loadExample(page, 'Fibonacci')
  await expect(editorContent(page)).toContainText('// title: Fibonacci')
  await clickMenu(app, MENU_IDS.save)

  // Assert
  await expect.poll(() => recorded(app, 'save')).toHaveLength(2)
  expect(await windowTitle(app)).toBe('Hindsight')
  expect(readFileSync(b, 'utf8')).toBe('print("b")\n')
  expect(readFileSync(a, 'utf8')).toBe('print("a")\n')
})

/** Whether the studio sends Save As a starting file yet (src/studio/desktop/connect.ts). */
const STUDIO_SUGGESTS = readFileSync(
  join(DESKTOP_DIR, '..', 'src', 'studio', 'desktop', 'connect.ts'),
  'utf8',
).includes('suggestion')

test('File > Save As on an opened file starts the Save dialog at that file', async () => {
  test.skip(!STUDIO_SUGGESTS, 'the studio does not send a suggestion with Save As yet')

  // Arrange
  const path = programFile('suggested.sight')
  const { app } = await startWith(path)
  await stubSaveDialog(app, null)

  // Act
  await clickMenu(app, MENU_IDS.saveAs)

  // Assert
  await expect.poll(() => recorded(app, 'save')).toEqual([path])
})

// --- View > Reload -----------------------------------------------------------------------------

test('View > Reload with unsaved changes asks; Cancel keeps the page, Reload reloads it', async () => {
  // Arrange: a mark on the page that a reload would wipe.
  const started = await startWith(programFile('reloaded.sight'))
  const { app, page } = started
  await edit(started, EDITED, '\u25cf reloaded.sight \u2014 Hindsight')
  const marked = () => page.evaluate(() => 'reloadMark' in window)
  await page.evaluate(() => Object.assign(window, { reloadMark: true }))
  await stubMessageBox(app, 'Cancel')

  // Act: Cancel keeps the page.
  await clickMenu(app, MENU_IDS.reload)

  // Assert
  await expect.poll(() => recorded(app, 'message')).toEqual(['Reload Hindsight?'])
  expect(await marked()).toBe(true)
  expect(await windowTitle(app)).toBe('\u25cf reloaded.sight \u2014 Hindsight')

  // Act: Reload reloads it. (Waiting for the new page's load, not polling the old one, whose
  // context the reload destroys mid-call.)
  await stubMessageBox(app, 'Reload')
  const reloaded = page.waitForEvent('load')
  await clickMenu(app, MENU_IDS.reload)
  await reloaded

  // Assert: the new page has no document, so the window keeps the app's name.
  expect(await marked()).toBe(false)
  await waitForStudio(page)
  await expect.poll(() => windowTitle(app)).toBe('Hindsight')
})

test('View > Reload without unsaved changes reloads at once', async () => {
  // Arrange
  const { app, page } = await startWith(programFile('reloaded.sight'))
  await page.evaluate(() => Object.assign(window, { reloadMark: true }))
  await stubMessageBox(app, 'Cancel')

  // Act
  const reloaded = page.waitForEvent('load')
  await clickMenu(app, MENU_IDS.reload)
  await reloaded

  // Assert
  expect(await page.evaluate(() => 'reloadMark' in window)).toBe(false)
  expect(await recorded(app, 'message')).toEqual([])
  await waitForStudio(page)
  await expect.poll(() => windowTitle(app)).toBe('Hindsight')
})

// --- the window itself -------------------------------------------------------------------------

test('links to the web open in the default browser, never in the app', async () => {
  // Arrange
  const { app, page } = await start()
  await stubOpenExternal(app)

  // Act
  const opened = await page.evaluate(() => window.open('https://example.com/docs'))
  await page.evaluate(() => window.open('file:///C:/Windows/System32/notepad.exe'))
  await page.evaluate(() => location.assign('https://example.com/away'))

  // Assert
  expect(opened).toBeNull()
  await expect
    .poll(() => recorded(app, 'external'))
    .toEqual(['https://example.com/docs', 'https://example.com/away'])
  expect(await windowCount(app)).toBe(1)
  expect(page.url()).toBe('app://studio/index.html')
})

test('the window opens again where it was left', async () => {
  // Arrange
  const first = await start()
  const placed = await first.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setBounds({ x: 40, y: 40, width: 760, height: 540 })
    return window.getBounds()
  })
  await first.app.close()

  // Act
  const second = await start([], first.userDataDir)
  const restored = await second.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBounds(),
  )

  // Assert: to within the rounding of a scaled display.
  for (const side of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(restored[side] - placed[side]), side).toBeLessThanOrEqual(4)
})

test('the menus are installed: File with its shortcuts, Edit with the clipboard roles', async () => {
  // Arrange
  const { app } = await start()

  // Act
  const menus = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((menu) => ({
      label: menu.label,
      items: (menu.submenu?.items ?? []).map((item) => ({
        label: item.label,
        role: item.role ?? null,
        accelerator: item.accelerator ?? null,
      })),
    })),
  )

  // Assert
  const file = menus.find((menu) => menu.label === 'File')!
  const edit = menus.find((menu) => menu.label === 'Edit')!
  expect(file.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'New', accelerator: 'CmdOrCtrl+N' }),
      expect.objectContaining({ label: 'Open…', accelerator: 'CmdOrCtrl+O' }),
      expect.objectContaining({ label: 'Save', accelerator: 'CmdOrCtrl+S' }),
      expect.objectContaining({ label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S' }),
    ]),
  )
  expect(edit.items.map((item) => item.role?.toLowerCase())).toEqual(
    expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']),
  )
  expect(menus.map((menu) => menu.label)).toEqual(
    expect.arrayContaining(['File', 'Edit', 'View', 'Window', 'Help']),
  )
})

test('a page that crashes can be reloaded', async () => {
  // Arrange
  const { app } = await start()
  await stubMessageBox(app, 'Reload')

  // Act
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer(),
  )

  // Assert: Playwright gives up on a crashed page, so the reloaded one is read from the app.
  await expect.poll(() => recorded(app, 'message')).toEqual(['Hindsight stopped working'])
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
          "document.querySelector('.ch-status-line')?.textContent ?? ''",
        ),
      ),
    )
    .toMatch(/Finished/)
})
