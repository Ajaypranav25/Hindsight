/**
 * The studio's window: its placement, title, open requests and the unsaved-changes prompt. The
 * rules live in pure modules (ready-queue, document, window-state); this class carries them out.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  BrowserWindow,
  dialog,
  nativeTheme,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import type {
  DesktopCommand,
  DesktopDocumentState,
  DesktopOpenRequest,
  DesktopSaveResult,
} from '../../../src/studio/desktop/bridge'
import {
  answerOf,
  closePrompt,
  closeStep,
  INITIAL_CLOSE_STATE,
  reloadPrompt,
  representedFilename,
  windowTitle,
  type CloseEffect,
  type CloseEvent,
  type CloseState,
} from '../document'
import { APP_NAME } from '../identity'
import { CHANNELS, versionSwitch } from '../messages'
import { isAppUrl, STUDIO_ENTRY_URL } from '../origin'
import { ReadyQueue } from '../ready-queue'
import { MIN_SIZE, parseWindowState, placeWindow, serializeWindowState } from '../window-state'

const NO_DOCUMENT: DesktopDocumentState = { name: null, dirty: false }

/** The studio's page background (src/studio/styles/tokens.css), so the window never flashes white. */
const BACKGROUND = { light: '#e9eee8', dark: '#0e1319' } as const

export interface StudioWindowOptions {
  readonly preload: string
  /** The window icon on Linux; Windows and macOS take theirs from the executable and bundle. */
  readonly linuxIcon: string
  readonly version: string
  /** Where the window's size and position are kept between runs. */
  readonly stateFile: string
}

export interface StudioWindowHooks {
  /** The user chose to keep the window open with unsaved changes: a quit in progress stops. */
  onStay(): void
}

function loadState(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export class StudioWindow {
  readonly window: BrowserWindow
  private readonly requests = new ReadyQueue<DesktopOpenRequest>()
  private closeState: CloseState = INITIAL_CLOSE_STATE
  private document: DesktopDocumentState = NO_DOCUMENT
  private knownPath: string | null = null

  constructor(
    private readonly options: StudioWindowOptions,
    private readonly hooks: StudioWindowHooks,
  ) {
    const workAreas = screen.getAllDisplays().map((display) => display.workArea)
    const placement = placeWindow(parseWindowState(loadState(options.stateFile)), workAreas)
    this.window = new BrowserWindow({
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: APP_NAME,
      icon: process.platform === 'linux' ? options.linuxIcon : undefined,
      backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        additionalArguments: [versionSwitch(options.version)],
      },
    })
    this.wireWindow(placement.maximized)
    this.wirePage()
    this.window.loadURL(STUDIO_ENTRY_URL).catch((error: unknown) => {
      console.error('The studio did not load:', error)
    })
  }

  get alive(): boolean {
    return !this.window.isDestroyed()
  }

  /** True when an IPC message comes from the studio page in this window's main frame. */
  isSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!this.alive || event.sender !== this.window.webContents) return false
    const frame = event.senderFrame
    return frame !== null && frame.parent === null && isAppUrl(frame.url)
  }

  /** Delivers an open request now, or once the studio is ready for it. */
  open(request: DesktopOpenRequest, path: string | null): void {
    if (path !== null) this.knownPath = path
    for (const ready of this.requests.push(request)) this.send(CHANNELS.open, ready)
  }

  /** Sends a menu command; dropped while the studio is not listening (it is still loading). */
  command(command: DesktopCommand): void {
    if (this.requests.isReady) this.send(CHANNELS.command, command)
  }

  markReady(): void {
    for (const request of this.requests.markReady()) this.send(CHANNELS.open, request)
  }

  setDocument(state: DesktopDocumentState): void {
    this.showDocument(state)
    this.step({ type: 'document', dirty: state.dirty })
  }

  saveFinished(result: DesktopSaveResult): void {
    if (result.ok) this.knownPath = result.path
    this.step({ type: 'save-finished', ok: result.ok, now: Date.now() })
  }

  focus(): void {
    if (!this.alive) return
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }

  /** Reloads the studio; with unsaved changes, only once the user agrees to lose them. */
  async reload(): Promise<void> {
    if (!this.alive) return
    if (this.closeState.dirty) {
      const prompt = reloadPrompt(this.document.name)
      const { response } = await dialog.showMessageBox(this.window, {
        type: 'warning',
        ...prompt,
        buttons: [...prompt.buttons],
        noLink: true,
      })
      if (response !== 0 || !this.alive) return
    }
    this.window.webContents.reload()
  }

  toggleFullScreen(): void {
    if (this.alive) this.window.setFullScreen(!this.window.isFullScreen())
  }

  private send(channel: string, payload: unknown): void {
    if (this.alive) this.window.webContents.send(channel, payload)
  }

  private wireWindow(maximized: boolean): void {
    this.window.once('ready-to-show', () => {
      if (maximized) this.window.maximize()
      this.window.show()
    })
    // The title is the document's (setDocument), not the page's <title>.
    this.window.on('page-title-updated', (event) => event.preventDefault())
    this.window.on('close', (event) => {
      const effect = this.step({ type: 'close-requested', now: Date.now() })
      if (effect === 'prevent' || effect === 'prompt') event.preventDefault()
      else this.saveState()
    })
  }

  private wirePage(): void {
    const contents = this.window.webContents
    // A new page (a reload) has not subscribed yet and knows nothing of the old one's document.
    contents.on('did-navigate', () => this.resetPage())
    // The unsaved-changes prompt is the app's; a page's beforeunload never blocks closing.
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return
      this.resetPage()
      void this.offerReload(details.reason)
    })
  }

  private showDocument(state: DesktopDocumentState): void {
    this.document = state
    this.window.setTitle(windowTitle(state))
    if (process.platform !== 'darwin') return
    this.window.setDocumentEdited(state.dirty)
    this.window.setRepresentedFilename(representedFilename(state.name, this.knownPath))
  }

  private resetPage(): void {
    this.requests.reset()
    this.showDocument(NO_DOCUMENT)
    this.step({ type: 'page-reset' })
  }

  private step(event: CloseEvent): CloseEffect {
    const { state, effect } = closeStep(this.closeState, event)
    this.closeState = state
    if (effect === 'prompt') void this.prompt()
    else if (effect === 'save-and-close') this.send(CHANNELS.command, 'save-and-close')
    else if (effect === 'close') setImmediate(() => this.alive && this.window.close())
    else if (effect === 'stay') this.hooks.onStay()
    return effect
  }

  private async prompt(): Promise<void> {
    const prompt = closePrompt(this.document.name, process.platform)
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'warning',
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: prompt.defaultId,
      cancelId: prompt.cancelId,
      noLink: true,
    })
    this.step({ type: 'answer', answer: answerOf(prompt, response), now: Date.now() })
  }

  private async offerReload(reason: string): Promise<void> {
    if (!this.alive) return
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'error',
      message: `${APP_NAME} stopped working`,
      detail: `The studio's page ended unexpectedly (${reason}). Reload it to carry on.`,
      buttons: ['Reload', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (!this.alive) return
    if (response === 0) this.window.webContents.reload()
    else this.window.close()
  }

  private saveState(): void {
    if (!this.alive) return
    const state = { bounds: this.window.getNormalBounds(), maximized: this.window.isMaximized() }
    try {
      writeFileSync(this.options.stateFile, serializeWindowState(state))
    } catch (error) {
      console.error('Could not save the window position:', error)
    }
  }
}
