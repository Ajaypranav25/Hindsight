/**
 * Starting the desktop app for a test: the development build (dist/, as `npm start` runs it) or,
 * when HINDSIGHT_DESKTOP_APP names one, a packaged executable (release/<platform>-unpacked/...).
 * Each launch gets a fresh user-data folder, so tests never share storage or the single-instance
 * lock, and never register themselves as the system's hindsight:// handler.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { DesktopBridge } from '../../src/studio/desktop/bridge'
import { waitForRun } from '../../e2e/fixtures'

export const DESKTOP_DIR = resolve(__dirname, '..')
export const REPOSITORY_DIR = resolve(DESKTOP_DIR, '..')

/** The packaged app under test, or undefined to run the development build. */
export const PACKED_APP = process.env.HINDSIGHT_DESKTOP_APP
  ? resolve(DESKTOP_DIR, process.env.HINDSIGHT_DESKTOP_APP)
  : undefined

/**
 * True once the studio drives the bridge itself (src/studio/desktop/connect.ts subscribes and
 * calls ready() at start-up). Tests that play the studio's part through the bridge run only before
 * that; tests of what the studio then does with requests run only after.
 */
export const STUDIO_CONNECTED = existsSync(join(REPOSITORY_DIR, 'src/studio/desktop/connect.ts'))

export const APP_VERSION = (
  JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')) as { version: string }
).version

/** `window` with the bridge, inside page.evaluate. */
export type BridgeWindow = Window & { readonly hindsightDesktop: DesktopBridge }

export interface DesktopApp {
  readonly app: ElectronApplication
  readonly page: Page
  readonly userDataDir: string
}

export interface LaunchOptions {
  /** Files and links to pass on the command line. */
  readonly args?: readonly string[]
  /** Reuse a user-data folder (window placement, storage) from an earlier launch. */
  readonly userDataDir?: string
  readonly cwd?: string
}

export function newUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'hindsight-desktop-e2e-'))
}

function environment(userDataDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return { ...env, HINDSIGHT_USER_DATA_DIR: userDataDir, HINDSIGHT_NO_PROTOCOL_CLIENT: '1' }
}

/** The command line that starts the app, before the files and links to open. */
function appCommand(): { readonly command: string; readonly args: readonly string[] } {
  if (PACKED_APP !== undefined) return { command: PACKED_APP, args: [] }
  // The electron package's main export is the path of its executable.
  const electronPath = createRequire(join(DESKTOP_DIR, 'package.json'))('electron') as string
  return { command: electronPath, args: [DESKTOP_DIR] }
}

export async function launchApp(options: LaunchOptions = {}): Promise<DesktopApp> {
  const userDataDir = options.userDataDir ?? newUserDataDir()
  const { command, args } = appCommand()
  // Electron lives in desktop/node_modules, where Playwright (at the root) cannot find it itself.
  const app = await _electron.launch({
    executablePath: command,
    args: [...args, ...(options.args ?? [])],
    env: environment(userDataDir),
    cwd: options.cwd,
  })
  const page = await app.firstWindow()
  return { app, page, userDataDir }
}

/**
 * Starts a second copy of the app with `args`, as the system does when a file or link is opened
 * while the app runs; it hands them to the running copy and exits.
 */
export async function launchSecondInstance(userDataDir: string, args: readonly string[]) {
  const { command, args: base } = appCommand()
  const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : []
  const child = spawn(command, [...sandbox, ...base, ...args], {
    env: environment(userDataDir),
    stdio: 'ignore',
  })
  const code = await new Promise<number | null>((done, fail) => {
    child.once('error', fail)
    child.once('exit', done)
  })
  return code
}

/** Waits until the studio has loaded and its first recording has ended. */
export async function waitForStudio(page: Page): Promise<void> {
  await expect(page.locator('#root')).not.toBeEmpty()
  await waitForRun(page)
}

/** Collects the page's errors and console.error messages from now on. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  return errors
}

/** The app window's title, as the operating system shows it. */
export function windowTitle(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '')
}

// --- the main process's dialogs and shell, stubbed --------------------------------------------

type Stubs = Record<string, unknown[]>

/**
 * Makes dialog.showSaveDialog answer with `path` (null: the user cancels) and record the default
 * path it was asked with. The main process calls the electron module's functions at call time,
 * so replacing them on that module reaches it.
 */
export async function stubSaveDialog(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, answer) => {
    const stubs = ((globalThis as { __stubs?: Stubs }).__stubs ??= {})
    stubs.save = []
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.SaveDialogOptions
      stubs.save!.push(options.defaultPath ?? null)
      return answer === null
        ? { canceled: true, filePath: '' }
        : { canceled: false, filePath: answer }
    }) as typeof dialog.showSaveDialog
  }, path)
}

/** Makes dialog.showOpenDialog answer with `paths`. */
export async function stubOpenDialog(app: ElectronApplication, paths: readonly string[]) {
  await app.evaluate(
    ({ dialog }, answer) => {
      dialog.showOpenDialog = (async () => ({
        canceled: answer.length === 0,
        filePaths: answer,
      })) as typeof dialog.showOpenDialog
    },
    [...paths],
  )
}

/**
 * Makes dialog.showMessageBox press the button labelled `button` and record each message, so a
 * test sees which prompts appeared.
 */
export async function stubMessageBox(app: ElectronApplication, button: string) {
  await app.evaluate(({ dialog }, label) => {
    const stubs = ((globalThis as { __stubs?: Stubs }).__stubs ??= {})
    stubs.message = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.MessageBoxOptions
      stubs.message!.push(options.message)
      const response = Math.max(0, (options.buttons ?? []).indexOf(label))
      return { response, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, button)
}

/** Makes shell.openExternal record its URLs instead of opening a browser. */
export async function stubOpenExternal(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const stubs = ((globalThis as { __stubs?: Stubs }).__stubs ??= {})
    stubs.external = []
    shell.openExternal = async (url: string) => {
      stubs.external!.push(url)
    }
  })
}

/** What a stub recorded: 'save' (default paths), 'message' (prompts) or 'external' (URLs). */
export function recorded(app: ElectronApplication, stub: 'save' | 'message' | 'external') {
  return app.evaluate(
    (_electron, name) => [...((globalThis as { __stubs?: Stubs }).__stubs?.[name] ?? [])],
    stub,
  )
}

/** Clicks a menu item by id (menu-template.ts MENU_IDS), as the user would. */
export async function clickMenu(app: ElectronApplication, id: string) {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
}

/** Asks the app's window to close (the close button, Ctrl+W, quitting). */
export async function closeWindow(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
}

/** The number of open windows. */
export function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

// --- playing the studio's part ----------------------------------------------------------------

/**
 * Subscribes to the bridge's open requests and commands from the page, calls ready() as the
 * studio does, and keeps what arrives (trace bytes as plain arrays) for `received`.
 */
export async function listenOnBridge(page: Page) {
  await page.evaluate(() => {
    const bridge = (window as unknown as BridgeWindow).hindsightDesktop
    const log: unknown[] = []
    ;(window as unknown as { __bridgeLog: unknown[] }).__bridgeLog = log
    bridge.onOpen((request) =>
      log.push(request.kind === 'trace' ? { ...request, bytes: [...request.bytes] } : request),
    )
    bridge.onCommand((command) => log.push({ command }))
    bridge.ready()
  })
}

/** Everything the bridge listener got so far. */
export function received(page: Page): Promise<unknown[]> {
  return page.evaluate(() => [...(window as unknown as { __bridgeLog: unknown[] }).__bridgeLog])
}

/**
 * Quits the app without its unsaved-changes prompt (which would wait for an answer). A closed
 * window may already have taken the app with it, on Windows and Linux.
 */
export async function closeApp(desktop: DesktopApp | undefined): Promise<void> {
  if (desktop === undefined) return
  await desktop.app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy())
    .catch(() => undefined)
  await desktop.app.close()
}
