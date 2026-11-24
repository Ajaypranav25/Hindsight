/**
 * Wires the studio to the Hindsight desktop app through the bridge its preload script defines
 * (bridge.ts). The app owns files, windows and links; this module turns its open requests and menu
 * commands into store actions, saves the program through the app, and reports which file the
 * program belongs to and whether it has unsaved changes, for the title bar and the close prompt.
 */
import type { StoreApi } from 'zustand/vanilla'
import { momentFromFragment } from '../lib/share'
import type { Notice, StudioStore } from '../state/types'
import type {
  DesktopBridge,
  DesktopCommand,
  DesktopDocumentState,
  DesktopOpenRequest,
  DesktopSaveRequest,
  DesktopSaveResult,
} from './bridge'

/** The file the program belongs to. */
export interface DesktopDocument {
  readonly path: string
  readonly name: string
  /** The text last read from or written to the file. */
  readonly savedSource: string
}

export const BAD_LINK_NOTICE: Notice = {
  text: 'This link does not carry a program Hindsight can open.',
  tone: 'error',
}

/** The title bar's view of the program: its file's name, and whether it differs from the file. */
export function documentState(
  document: DesktopDocument | null,
  source: string,
): DesktopDocumentState {
  if (document === null) return { name: null, dirty: false }
  return { name: document.name, dirty: source !== document.savedSource }
}

/**
 * Connects `store` to the desktop app: subscribes to the app's open requests and menu commands,
 * then tells the app it is ready (so requests made at launch arrive after the subscriptions).
 * Returns the disconnect.
 */
export function connectDesktop(store: StoreApi<StudioStore>, bridge: DesktopBridge): () => void {
  return new DesktopConnection(store, bridge).connect()
}

class DesktopConnection {
  private document: DesktopDocument | null = null
  private reported: DesktopDocumentState | null = null
  /** While positive, changes are reported once at the end, so the app never sees a half-step. */
  private holds = 0
  /** Counts programs opened over the editor's, so a save that finishes later binds no stranger. */
  private replacements = 0
  /** The editor's program when a trace started opening; once it changes, the file is left. */
  private traceReplaces: string | null = null
  /** Saves run one at a time, so a second Save writes to the file the first one chose. */
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: StoreApi<StudioStore>,
    private readonly bridge: DesktopBridge,
  ) {}

  connect(): () => void {
    const stops = [
      this.bridge.onOpen((request) => this.open(request)),
      this.bridge.onCommand((command) => this.command(command)),
      this.store.subscribe((state, previous) => this.sourceChanged(state.source, previous.source)),
    ]
    this.report()
    this.bridge.ready()
    return () => stops.forEach((stop) => stop())
  }

  // --- opening ------------------------------------------------------------------------------

  private open(request: DesktopOpenRequest): void {
    switch (request.kind) {
      case 'program': {
        const { source, path, name } = request
        return this.replace({ path, name, savedSource: source }, (actions) =>
          actions.openProgramFile(source, name),
        )
      }
      case 'link':
        return this.openLink(request.fragment)
      case 'trace':
        return void this.openTrace(request.bytes)
    }
  }

  private openLink(fragment: string): void {
    const moment = momentFromFragment(fragment)
    if (moment === null) return this.store.getState().showNotice(BAD_LINK_NOTICE)
    this.replace(null, (actions) => actions.openSharedSource(moment.source, moment.time))
  }

  /**
   * A trace's program replaces the editor's only once the file has been read, and not at all when
   * it cannot be, so the program leaves its file when (and if) its text is replaced.
   */
  private async openTrace(bytes: Uint8Array): Promise<void> {
    this.traceReplaces = this.store.getState().source
    try {
      await this.store.getState().openTraceFile(bytes)
    } catch (error) {
      this.store.getState().showNotice({
        text: `Could not open the trace: ${messageOf(error)}`,
        tone: 'error',
      })
    } finally {
      this.traceReplaces = null
    }
  }

  /** Puts a new program in the editor with `change`; it then belongs to `document`. */
  private replace(document: DesktopDocument | null, change: (actions: StudioStore) => void): void {
    this.holds++
    try {
      change(this.store.getState())
      this.replacements++
      this.document = document
    } finally {
      this.holds--
      this.report()
    }
  }

  private sourceChanged(source: string, previous: string): void {
    if (source === previous) return
    if (this.traceReplaces !== null && source !== this.traceReplaces) {
      this.traceReplaces = null
      this.replacements++
      this.document = null
    }
    this.report()
  }

  // --- menu commands ------------------------------------------------------------------------

  private command(command: DesktopCommand): void {
    switch (command) {
      case 'new':
        return this.replace(null, (actions) => actions.newProgram())
      case 'save-as':
        return this.queueSave(true)
      case 'save':
      case 'save-and-close':
        return this.queueSave(false)
    }
  }

  private queueSave(ask: boolean): void {
    this.saving = this.saving
      .then(() => this.save(ask))
      .catch((error: unknown) => this.saveFailed(messageOf(error)))
  }

  /** Writes the program to its file (or, with `ask` or without a file, to one the user picks). */
  private async save(ask: boolean): Promise<void> {
    const source = this.store.getState().source
    const path = ask ? null : (this.document?.path ?? null)
    const replacements = this.replacements
    const result = await this.saveProgram({ source, path })
    if (!result.ok) {
      if (result.reason === 'failed') this.saveFailed(result.message)
      return
    }
    // A program opened while the dialog was up is not the one that was saved.
    if (this.replacements !== replacements) return
    this.document = { path: result.path, name: result.name, savedSource: source }
    this.report()
  }

  private async saveProgram(request: DesktopSaveRequest): Promise<DesktopSaveResult> {
    try {
      return await this.bridge.saveProgram(request)
    } catch (error) {
      return { ok: false, reason: 'failed', message: messageOf(error) }
    }
  }

  private saveFailed(message: string): void {
    this.store
      .getState()
      .showNotice({ text: `Could not save the program: ${message}`, tone: 'error' })
  }

  // --- reporting ----------------------------------------------------------------------------

  /** Tells the app the document's name and unsaved state when either changed. */
  private report(): void {
    if (this.holds > 0) return
    const state = documentState(this.document, this.store.getState().source)
    const last = this.reported
    if (last !== null && last.name === state.name && last.dirty === state.dirty) return
    this.reported = state
    this.bridge.setDocument(state)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
