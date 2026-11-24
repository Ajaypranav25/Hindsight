/**
 * The contract between the studio and the Hindsight desktop app (desktop/). The app's preload
 * script exposes a `DesktopBridge` as `window.hindsightDesktop` through Electron's contextBridge;
 * in a browser it is absent and the studio behaves as it always has.
 *
 * The app owns windows, menus, files on disk and `hindsight://` links; the studio owns the program
 * text. So the app tells the studio what to open (`onOpen`) and which menu command was chosen
 * (`onCommand`), and the studio asks the app to write the program (`saveProgram`) and reports the
 * document's name and unsaved state (`setDocument`) for the window title and the close prompt.
 *
 * This module is pure (no DOM, no Electron), so the app's main process bundles it too: both sides
 * build and read `hindsight://` links with the same code.
 */
import { momentFromFragment, shareFragment } from '../lib/share'

/** The global the preload script defines. */
export const DESKTOP_BRIDGE_KEY = 'hindsightDesktop'

/** Something the app asks the studio to open. */
export type DesktopOpenRequest =
  /** A `.sight` file: File > Open, a file passed at launch, or one opened from the OS. */
  | {
      readonly kind: 'program'
      readonly source: string
      readonly path: string
      /** The file's name, for the title bar (`fib.sight`). */
      readonly name: string
    }
  /** A `.sighttrace` file; the studio opens it as the "Open trace…" menu does. */
  | { readonly kind: 'trace'; readonly bytes: Uint8Array; readonly name: string }
  /** A `hindsight://open/#src=…&t=N` link: `fragment` is its `#src=…` part, already validated. */
  | { readonly kind: 'link'; readonly fragment: string }

/**
 * Menu commands the studio carries out, because it holds the program text.
 * - `save`: write the program to its file, or ask for one when it has none.
 * - `save-as`: always ask for a file.
 * - `new`: start an empty program that belongs to no file.
 * - `save-and-close`: the user chose Save in the app's "unsaved changes" prompt; the studio
 *   saves exactly as for `save`, and the app closes the window once that save succeeds.
 */
export type DesktopCommand = 'save' | 'save-as' | 'new' | 'save-and-close'

export interface DesktopSaveRequest {
  readonly source: string
  /** The file to write; null asks the user for one (Save As). */
  readonly path: string | null
}

export type DesktopSaveResult =
  | { readonly ok: true; readonly path: string; readonly name: string }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'failed'; readonly message: string }

/** What the title bar and the close prompt need. */
export interface DesktopDocumentState {
  /** The program's file name, or null when it belongs to no file. */
  readonly name: string | null
  /** The program differs from its file (always false without a file). */
  readonly dirty: boolean
}

export interface DesktopBridge {
  readonly platform: 'win32' | 'darwin' | 'linux'
  /** The app's version (the same as the hindsight-lang package). */
  readonly version: string
  /** Subscribes to open requests; returns the unsubscribe. */
  onOpen(listener: (request: DesktopOpenRequest) => void): () => void
  /** Subscribes to menu commands; returns the unsubscribe. */
  onCommand(listener: (command: DesktopCommand) => void): () => void
  /** Writes the program to `path`, or asks for a file first when `path` is null. */
  saveProgram(request: DesktopSaveRequest): Promise<DesktopSaveResult>
  /** Reports the document's name and unsaved state (the title bar, the close prompt). */
  setDocument(state: DesktopDocumentState): void
  /**
   * The studio has subscribed to `onOpen` and `onCommand`. Requests that arrived before that
   * (files and links passed when the app was launched) are delivered after this call.
   */
  ready(): void
}

/** The desktop bridge when the studio runs inside the app, otherwise null. */
export function desktopBridge(host: object = globalThis): DesktopBridge | null {
  const bridge = (host as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
  if (typeof bridge !== 'object' || bridge === null) return null
  const candidate = bridge as Partial<DesktopBridge>
  return typeof candidate.onOpen === 'function' &&
    typeof candidate.onCommand === 'function' &&
    typeof candidate.saveProgram === 'function' &&
    typeof candidate.setDocument === 'function' &&
    typeof candidate.ready === 'function'
    ? (bridge as DesktopBridge)
    : null
}

// --- hindsight:// links ----------------------------------------------------------------------

/** The scheme the app registers with the OS. */
export const APP_LINK_SCHEME = 'hindsight'

/** Where program links point: `hindsight://open/#src=…&t=N`. */
export const APP_LINK_BASE = `${APP_LINK_SCHEME}://open`

/**
 * The longest `hindsight://` link. On Windows the OS hands a link to the app on its command line,
 * which holds at most 32,767 characters, so links stay well below that on every system.
 */
export const MAX_APP_LINK_LENGTH = 30_000

/**
 * A link that opens `source` in the desktop app, with the pen at `time` when given; null when the
 * program is too long for a link (open its file instead).
 */
export function appLink(source: string, time: number | null): string | null {
  const fragment = shareFragment(source, time)
  if (fragment === null) return null
  const link = `${APP_LINK_BASE}/${fragment}`
  return link.length <= MAX_APP_LINK_LENGTH ? link : null
}

/**
 * The `#src=…[&t=N]` fragment of a program link the app should open, or null when `url` is not a
 * `hindsight://open` link carrying a program that decodes.
 */
export function fragmentOfAppLink(url: string): string | null {
  if (url.length > MAX_APP_LINK_LENGTH) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_LINK_SCHEME}:` || parsed.hostname !== 'open') return null
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null
  if (parsed.search !== '' || parsed.username !== '' || parsed.password !== '') return null
  if (parsed.port !== '') return null
  return momentFromFragment(parsed.hash) === null ? null : parsed.hash
}
