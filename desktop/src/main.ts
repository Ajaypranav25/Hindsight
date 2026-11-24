/**
 * The Hindsight desktop app's main process: one window running the studio (served from
 * app://studio/), the menus, files on disk and `hindsight://` links. The studio talks to it only
 * through the preload's DesktopBridge (src/studio/desktop/bridge.ts).
 *
 * Environment variables, for tests and development only:
 * - HINDSIGHT_USER_DATA_DIR: keep settings, storage and the single-instance lock in this folder.
 * - HINDSIGHT_NO_PROTOCOL_CLIENT=1: do not register this copy as the hindsight:// handler.
 */
import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, session, type IpcMainEvent } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_LINK_SCHEME, fragmentOfAppLink } from '../../src/studio/desktop/bridge'
import { APP_ID, APP_NAME } from './identity'
import { installMenu } from './glue/menu'
import { registerIpc } from './glue/ipc'
import { UserFiles } from './glue/files'
import { registerAppScheme, serveStudio } from './glue/protocol'
import { hardenSession, hardenWebContents, openExternally } from './glue/security'
import { StudioWindow } from './glue/studio-window'
import {
  appFolderArg,
  instanceData,
  launchTargets,
  parseInstanceData,
  type LaunchContext,
  type LaunchTarget,
} from './launch-args'
import { HELP_LINKS } from './menu-template'

const STUDIO_ROOT = join(__dirname, 'studio')
const PRELOAD = join(__dirname, 'preload.js')
const WINDOW_STATE_FILE = 'window-state.json'

function currentLaunch(): LaunchContext {
  return { argv: process.argv, cwd: process.cwd(), defaultApp: process.defaultApp === true }
}

function useUserDataFromEnvironment(): void {
  const folder = process.env.HINDSIGHT_USER_DATA_DIR
  if (folder !== undefined && isAbsolute(folder)) app.setPath('userData', folder)
}

/** Makes this copy of the app the handler of hindsight:// links. */
function registerLinkHandler(): void {
  if (process.env.HINDSIGHT_NO_PROTOCOL_CLIENT === '1') return
  if (!process.defaultApp) {
    app.setAsDefaultProtocolClient(APP_LINK_SCHEME)
    return
  }
  // In development the handler is Electron itself, which needs the app's folder to run it.
  const folder = appFolderArg(process.argv)
  if (folder !== null)
    app.setAsDefaultProtocolClient(APP_LINK_SCHEME, process.execPath, [resolve(folder)])
}

/** The app once it holds the single-instance lock. */
class DesktopApp {
  private readonly files = new UserFiles(process.platform)
  private studio: StudioWindow | null = null
  /** Targets that arrived before the app was ready. */
  private waiting: LaunchTarget[] = []
  private quitting = false

  start(): void {
    this.waiting = launchTargets(currentLaunch())
    this.listenForTargets()
    app.on('before-quit', () => {
      this.quitting = true
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
    app.on('activate', () => {
      if (app.isReady()) this.window()
    })
    hardenWebContents()
    app
      .whenReady()
      .then(() => this.ready())
      .catch((error: unknown) => {
        console.error('Hindsight could not start:', error)
        app.exit(1)
      })
  }

  private listenForTargets(): void {
    // macOS: double-clicked files and hindsight:// links arrive as events, possibly before ready.
    app.on('open-file', (event, path) => {
      event.preventDefault()
      this.openTarget({ kind: 'file', path })
    })
    app.on('open-url', (event, url) => {
      event.preventDefault()
      const fragment = fragmentOfAppLink(url)
      if (fragment !== null) this.openTarget({ kind: 'link', fragment })
    })
    // Windows and Linux: a second launch hands its files and links to this one.
    app.on('second-instance', (_event, argv, cwd, data) => {
      const launch = parseInstanceData(data) ?? { argv, cwd, defaultApp: process.defaultApp }
      for (const target of launchTargets(launch)) this.openTarget(target)
      if (app.isReady()) this.window().focus()
    })
  }

  private ready(): void {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'MIT License',
      website: HELP_LINKS.repository,
    })
    hardenSession(session.defaultSession)
    serveStudio(STUDIO_ROOT)
    registerIpc({
      studioFor: (event) => this.studioFor(event),
      save: (studio, request) => this.files.save(studio.window, request),
    })
    installMenu({
      newProgram: () => this.window().command('new'),
      open: () => void this.chooseAndOpen(),
      save: () => this.studio?.command('save'),
      saveAs: () => this.studio?.command('save-as'),
      toggleFullScreen: () => this.studio?.toggleFullScreen(),
      openExternal: openExternally,
      showAbout: () => void this.showAbout(),
    })
    registerLinkHandler()
    this.window()
    const waiting = this.waiting
    this.waiting = []
    for (const target of waiting) this.openTarget(target)
  }

  private studioFor(event: IpcMainEvent | IpcMainInvokeEvent): StudioWindow | null {
    return this.studio !== null && this.studio.isSender(event) ? this.studio : null
  }

  /** The studio's window, opened when there is none (at start, or on macOS after closing it). */
  private window(): StudioWindow {
    if (this.studio !== null && this.studio.alive) return this.studio
    const studio = new StudioWindow(
      {
        preload: PRELOAD,
        version: app.getVersion(),
        stateFile: join(app.getPath('userData'), WINDOW_STATE_FILE),
      },
      {
        onStay: () => {
          this.quitting = false
        },
      },
    )
    studio.window.on('closed', () => {
      if (this.studio === studio) this.studio = null
      // macOS keeps running without windows, unless this close was part of quitting.
      if (this.quitting) app.quit()
    })
    this.studio = studio
    return studio
  }

  private openTarget(target: LaunchTarget): void {
    if (!app.isReady()) {
      this.waiting = [...this.waiting, target]
      return
    }
    if (target.kind === 'link') {
      this.window().open({ kind: 'link', fragment: target.fragment }, null)
      return
    }
    void this.openFile(target.path)
  }

  private async openFile(path: string): Promise<void> {
    const result = await this.files.read(path)
    const studio = this.window()
    if (result.ok) {
      studio.open(result.request, path)
      return
    }
    await dialog.showMessageBox(studio.window, {
      type: 'error',
      message: 'The file could not be opened',
      detail: result.message,
      noLink: true,
    })
  }

  private async chooseAndOpen(): Promise<void> {
    const path = await this.files.choose(this.studio?.alive ? this.studio.window : null)
    if (path !== null) this.openTarget({ kind: 'file', path })
  }

  private async showAbout(): Promise<void> {
    const { electron, chrome, node } = process.versions
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: `About ${APP_NAME}`,
      message: `${APP_NAME} ${app.getVersion()}`,
      detail: [
        'A tiny programming language with a time machine built in.',
        `Electron ${electron} · Chromium ${chrome} · Node.js ${node}`,
        `MIT License · ${HELP_LINKS.repository}`,
      ].join('\n\n'),
      buttons: ['OK'],
      noLink: true,
    }
    const parent = this.studio?.alive ? this.studio.window : BrowserWindow.getFocusedWindow()
    await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
  }
}

useUserDataFromEnvironment()
registerAppScheme()
app.enableSandbox()
if (app.requestSingleInstanceLock(instanceData(currentLaunch()))) new DesktopApp().start()
else app.quit()
