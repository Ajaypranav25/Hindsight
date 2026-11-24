/**
 * The studio's window: its placement, title, what it opens, and the unsaved-changes prompts (before
 * closing, and before something replaces the program). The rules live in pure modules
 * (ready-queue, document, replace-guard, window-state); this class carries them out.
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
  closeBusy,
  closePrompt,
  closeStep,
  INITIAL_CLOSE_STATE,
  offersReload,
  reloadPrompt,
  representedFilename,
  SAVE_AND_CLOSE_WINDOW_MS,
  windowTitle,
  type CloseEffect,
  type CloseEvent,
  type CloseState,
  type PromptAnswer,
} from '../document'
import { APP_NAME } from '../identity'
import { CHANNELS, versionSwitch } from '../messages'
import { isAppUrl, STUDIO_ENTRY_URL } from '../origin'
import { ReadyQueue } from '../ready-queue'
import {
  INITIAL_REPLACE_STATE,
  replaceStep,
  replacesProgram,
  replacing,
  SAVE_BEFORE_REPLACING_MS,
  type ReplaceEvent,
  type ReplaceState,
} from '../replace-guard'
import { MIN_SIZE, parseWindowState, placeWindow, serializeWindowState } from '../window-state'

const NO_DOCUMENT: DesktopDocumentState = { name: null, dirty: false }

/** The studio's page background (src/studio/styles/tokens.css), so the window never flashes white. */
const BACKGROUND = { light: '#e9eee8', dark: '#0e1319' } as const

/** A save's time-limit timer fires this much after the limit, so the limit has surely passed. */
const DEADLINE_MARGIN_MS = 50

/** What replaces the studio's program: an open request (and the file it was read from), or New. */
type Replacement =
  | { readonly kind: 'open'; readonly request: DesktopOpenRequest; readonly path: string | null }
  | { readonly kind: 'new' }

export interface StudioWindowOptions {
  readonly preload: string
  /** The window icon on Linux; Windows and macOS take theirs from the executable and bundle. */
  readonly linuxIcon: string
  readonly version: string
  /** Where the window's size and position are kept between runs. */
  readonly stateFile: string
}

export interface StudioWindowHooks {
  /** The window stays open with unsaved changes after all: a quit in progress stops. */
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
  /** What waits for the page to be ready: open requests and New. */
  private readonly deliveries = new ReadyQueue<Replacement>()
  private closeState: CloseState = INITIAL_CLOSE_STATE
  private replaceState: ReplaceState<Replacement> = INITIAL_REPLACE_STATE
  private document: DesktopDocumentState = NO_DOCUMENT
  private knownPath: string | null = null
  /** The window or its page is gone (closed, destroyed). */
  private ended = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

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
    return !this.ended && !this.window.isDestroyed()
  }

  /** True when an IPC message comes from the studio page in this window's main frame. */
  isSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    if (!this.alive || event.sender !== this.window.webContents) return false
    const frame = event.senderFrame
    return frame !== null && frame.parent === null && isAppUrl(frame.url)
  }

  /**
   * Opens `request` (read from the file at `path`, if any) in the studio: now, once the page is
   * ready, or once the user has said what to do with unsaved changes.
   */
  open(request: DesktopOpenRequest, path: string | null): void {
    this.replace({ kind: 'open', request, path })
  }

  /**
   * Carries out a menu command. New replaces the program, so it is asked about and waits for the
   * page like an open request; the saves are dropped while the page is not listening.
   */
  command(command: DesktopCommand): void {
    if (replacesProgram(command)) this.replace({ kind: 'new' })
    else if (this.deliveries.isReady) this.send(CHANNELS.command, command)
  }

  markReady(): void {
    for (const item of this.deliveries.markReady()) this.dispatch(item)
  }

  setDocument(state: DesktopDocumentState): void {
    this.showDocument(state)
    const now = Date.now()
    this.closeEvent({ type: 'document', dirty: state.dirty, now })
    this.replaceEvent({ type: 'document', dirty: state.dirty, now })
  }

  saveFinished(result: DesktopSaveResult): void {
    if (result.ok) this.knownPath = result.path
    const now = Date.now()
    this.closeEvent({ type: 'save-finished', ok: result.ok, now })
    this.replaceEvent({ type: 'save-finished', ok: result.ok, now })
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
      const effect = this.closeEvent({
        type: 'close-requested',
        now: Date.now(),
        replacing: replacing(this.replaceState),
      })
      if (effect === 'none') this.saveState()
      else event.preventDefault()
    })
    this.window.on('closed', () => this.end())
  }

  private wirePage(): void {
    const contents = this.window.webContents
    // A new page (a reload) has not subscribed yet and knows nothing of the old one's document.
    contents.on('did-navigate', () => this.resetPage())
    // The unsaved-changes prompt is the app's; a page's beforeunload never blocks closing.
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.on('destroyed', () => this.end())
    // Whatever the reason: on Linux, a page Chromium killed can even report a clean exit.
    contents.on('render-process-gone', (_event, details) => {
      if (!this.alive || !offersReload(this.closeState)) return
      this.resetPage()
      void this.offerReload(details.reason)
    })
  }

  private end(): void {
    this.ended = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  private showDocument(state: DesktopDocumentState): void {
    this.document = state
    if (!this.alive) return
    this.window.setTitle(windowTitle(state))
    if (process.platform !== 'darwin') return
    this.window.setDocumentEdited(state.dirty)
    this.window.setRepresentedFilename(representedFilename(state.name, this.knownPath))
  }

  private resetPage(): void {
    this.deliveries.reset()
    this.showDocument(NO_DOCUMENT)
    // The guard first, so what it holds for the close finds the new page's clean document.
    this.replaceEvent({ type: 'page-reset', now: Date.now() })
    this.closeEvent({ type: 'page-reset' })
  }

  // --- replacing the program ------------------------------------------------------------------

  private replace(item: Replacement): void {
    this.replaceEvent({ type: 'request', request: item, held: closeBusy(this.closeState) })
  }

  private replaceEvent(event: ReplaceEvent<Replacement>): void {
    const { state, effect } = replaceStep(this.replaceState, event)
    this.replaceState = state
    if (effect.type === 'prompt') void this.askBeforeReplacing()
    else if (effect.type === 'save') {
      this.send(CHANNELS.command, 'save')
      this.armDeadline(SAVE_BEFORE_REPLACING_MS)
    } else if (effect.type === 'deliver') {
      for (const item of effect.requests) this.deliver(item)
    }
  }

  /** Hands `item` to the studio now, or once its page is ready. */
  private deliver(item: Replacement): void {
    if (item.kind === 'open' && item.path !== null) this.knownPath = item.path
    for (const ready of this.deliveries.push(item)) this.dispatch(ready)
  }

  private dispatch(item: Replacement): void {
    if (item.kind === 'open') this.send(CHANNELS.open, item.request)
    else this.send(CHANNELS.command, 'new')
  }

  private async askBeforeReplacing(): Promise<void> {
    const answer = await this.askToSave()
    this.replaceEvent({ type: 'answer', answer, now: Date.now() })
  }

  // --- closing --------------------------------------------------------------------------------

  private closeEvent(event: CloseEvent): CloseEffect {
    const { state, effect } = closeStep(this.closeState, event)
    this.closeState = state
    if (effect === 'prompt') void this.askBeforeClosing()
    else if (effect === 'save-and-close') {
      this.send(CHANNELS.command, 'save-and-close')
      this.armDeadline(SAVE_AND_CLOSE_WINDOW_MS)
    } else if (effect === 'close') setImmediate(() => this.alive && this.window.close())
    else if (effect === 'stay') this.hooks.onStay()
    this.resumeReplacing()
    return effect
  }

  /** Requests held while the window was busy closing are taken up once it stays open. */
  private resumeReplacing(): void {
    if (this.replaceState.phase !== 'held') return
    if (closeBusy(this.closeState)) return
    this.replaceEvent({ type: 'resume' })
  }

  private async askBeforeClosing(): Promise<void> {
    const answer = await this.askToSave()
    this.closeEvent({ type: 'answer', answer, now: Date.now() })
  }

  // --- prompts and timers ---------------------------------------------------------------------

  /** Save / Don't Save / Cancel, for the document's unsaved changes. */
  private async askToSave(): Promise<PromptAnswer> {
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
    return answerOf(prompt, response)
  }

  /** Tells both rule sets when a save chosen in a prompt has run past `limit`. */
  private armDeadline(limit: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.alive) return
      const now = Date.now()
      this.closeEvent({ type: 'deadline', now })
      this.replaceEvent({ type: 'deadline', now })
    }, limit + DEADLINE_MARGIN_MS)
    this.timers.add(timer)
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
