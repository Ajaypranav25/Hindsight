/**
 * The app's window: its title and the unsaved-changes prompt, where it opens, what it does with
 * links to the web, and a crashed page.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { editorContent } from '../../e2e/fixtures'
import type { DesktopDocumentState } from '../../src/studio/desktop/bridge'
import {
  closeApp,
  closeWindow,
  launchApp,
  listenOnBridge,
  received,
  recorded,
  STUDIO_CONNECTED,
  stubMessageBox,
  stubOpenExternal,
  stubSaveDialog,
  waitForStudio,
  windowCount,
  windowTitle,
  type BridgeWindow,
  type DesktopApp,
} from './app'

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

function setDocument(page: Page, state: DesktopDocumentState) {
  return page.evaluate(
    (document) => (window as unknown as BridgeWindow).hindsightDesktop.setDocument(document),
    state,
  )
}

/** Resolves when the app's window has closed. */
function closed(page: Page): Promise<unknown> {
  return page.waitForEvent('close', { timeout: 15_000 })
}

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

test.describe('before the studio reports its document itself', () => {
  test.skip(STUDIO_CONNECTED, 'the studio reports its own document; see the tests below')

  test('setDocument names the window and marks unsaved changes', async () => {
    // Arrange
    const { app, page } = await start()

    // Act and assert
    await setDocument(page, { name: 'fib.sight', dirty: false })
    await expect.poll(() => windowTitle(app)).toBe('fib.sight \u2014 Hindsight')
    await setDocument(page, { name: 'fib.sight', dirty: true })
    await expect.poll(() => windowTitle(app)).toBe('\u25cf fib.sight \u2014 Hindsight')
    await setDocument(page, { name: '../fib.sight', dirty: false })
    await setDocument(page, { name: null, dirty: false })
    await expect.poll(() => windowTitle(app)).toBe('Hindsight')
  })

  test('closing without unsaved changes does not ask', async () => {
    // Arrange
    const { app, page } = await start()
    await stubMessageBox(app, 'Cancel')
    await setDocument(page, { name: 'fib.sight', dirty: false })
    const gone = closed(page)

    // Act
    await closeWindow(app)

    // Assert: a prompt would have been answered Cancel, keeping the window open.
    await gone
  })

  test("closing with unsaved changes asks; Cancel keeps the window, Don't Save closes it", async () => {
    // Arrange
    const { app, page } = await start()
    await setDocument(page, { name: 'fib.sight', dirty: true })
    await stubMessageBox(app, 'Cancel')

    // Act: Cancel.
    await closeWindow(app)

    // Assert
    await expect
      .poll(() => recorded(app, 'message'))
      .toEqual(['Do you want to save the changes you made to fib.sight?'])
    expect(await windowCount(app)).toBe(1)

    // Act: Don't Save.
    await stubMessageBox(app, "Don't Save")
    const gone = closed(page)
    await closeWindow(app)

    // Assert
    await gone
  })

  test('Save closes the window once the studio has saved', async () => {
    // Arrange: this test answers 'save-and-close' as the studio does, by saving.
    const { app, page } = await start()
    const folder = mkdtempSync(join(tmpdir(), 'hindsight-desktop-close-'))
    const target = join(folder, 'kept.sight')
    await stubSaveDialog(app, target)
    await stubMessageBox(app, 'Save')
    await page.evaluate(() => {
      const bridge = (window as unknown as BridgeWindow).hindsightDesktop
      bridge.onCommand((command) => {
        if (command === 'save-and-close') void bridge.saveProgram({ source: 'kept\n', path: null })
      })
      bridge.ready()
    })
    await setDocument(page, { name: 'kept.sight', dirty: true })
    const gone = closed(page)

    // Act
    await closeWindow(app)

    // Assert
    await gone
    expect(readFileSync(target, 'utf8')).toBe('kept\n')
  })

  test('Save keeps the window open when the save is cancelled', async () => {
    // Arrange
    const { app, page } = await start()
    await stubSaveDialog(app, null)
    await stubMessageBox(app, 'Save')
    await listenOnBridge(page)
    await page.evaluate(() => {
      const bridge = (window as unknown as BridgeWindow).hindsightDesktop
      bridge.onCommand((command) => {
        if (command === 'save-and-close') void bridge.saveProgram({ source: 'x', path: null })
      })
    })
    await setDocument(page, { name: 'kept.sight', dirty: true })

    // Act
    await closeWindow(app)

    // Assert
    await expect.poll(() => received(page)).toEqual([{ command: 'save-and-close' }])
    await expect.poll(() => recorded(app, 'save')).toHaveLength(1)
    await page.waitForTimeout(500)
    expect(await windowCount(app)).toBe(1)
    expect(await windowTitle(app)).toBe('\u25cf kept.sight \u2014 Hindsight')
  })
})

test.describe('once the studio reports its document itself', () => {
  test.skip(
    !STUDIO_CONNECTED,
    'needs the studio side of the bridge (src/studio/desktop/connect.ts)',
  )

  test('editing an opened file marks it unsaved, and closing asks first', async () => {
    // Arrange
    const folder = mkdtempSync(join(tmpdir(), 'hindsight-desktop-edit-'))
    const path = join(folder, 'edited.sight')
    writeFileSync(path, 'print("before")\n')
    const { app, page } = await start([path])
    await expect(editorContent(page)).toContainText('print("before")')
    await stubMessageBox(app, 'Cancel')

    // Act
    await editorContent(page).click()
    await page.keyboard.press('End')
    await page.keyboard.insertText(' ')
    await closeWindow(app)

    // Assert
    await expect.poll(() => windowTitle(app)).toBe('\u25cf edited.sight \u2014 Hindsight')
    await expect.poll(() => recorded(app, 'message')).toHaveLength(1)
    expect(await windowCount(app)).toBe(1)
  })
})
