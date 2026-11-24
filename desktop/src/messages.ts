/**
 * The IPC protocol between the main process and the preload script, which turns it into the
 * studio's DesktopBridge (src/studio/desktop/bridge.ts). Both ends treat what they receive as
 * untrusted: the main process does not trust the page, and the preload does not pass anything to
 * the page's listeners that is not exactly a contract value.
 *
 * The preload bundles this module and runs sandboxed, where only `electron` can be required, so
 * it imports no Node modules.
 */
import {
  fragmentOfAppLink,
  APP_LINK_BASE,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopDocumentState,
  type DesktopOpenRequest,
  type DesktopSaveRequest,
  type DesktopSaveResult,
} from '../../src/studio/desktop/bridge'

/** IPC channel names. */
export const CHANNELS = {
  /** main to page: a DesktopOpenRequest. */
  open: 'hindsight:open',
  /** main to page: a DesktopCommand from the menu or the close prompt. */
  command: 'hindsight:command',
  /** page to main (invoke): a DesktopSaveRequest, answered with a DesktopSaveResult. */
  saveProgram: 'hindsight:save-program',
  /** page to main: a DesktopDocumentState. */
  setDocument: 'hindsight:set-document',
  /** page to main: the studio subscribed; deliver what was queued. */
  ready: 'hindsight:ready',
} as const

/** The largest program the app reads or writes, in UTF-8 bytes. */
export const MAX_PROGRAM_BYTES = 5 * 1024 * 1024
/** Longer paths do not exist on any of the three systems (Windows' long-path limit is 32,767). */
export const MAX_PATH_LENGTH = 32_767
/** File names are at most 255 characters (or bytes) on every common file system. */
export const MAX_NAME_LENGTH = 255

const COMMANDS: ReadonlySet<string> = new Set<DesktopCommand>([
  'save',
  'save-as',
  'new',
  'save-and-close',
])

type Fields = Readonly<Record<string, unknown>>

/** A plain object's fields, or null for anything else (arrays, class instances, null). */
function fieldsOf(value: unknown): Fields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null ? (value as Fields) : null
}

/** The UTF-8 size of `text`, without encoding it when it is clearly small enough. */
export function utf8Length(text: string): number {
  return text.length * 3 <= MAX_PROGRAM_BYTES ? text.length : new TextEncoder().encode(text).length
}

function isProgramText(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value.length <= MAX_PROGRAM_BYTES && utf8Length(value) <= MAX_PROGRAM_BYTES
}

/** Absolute on one of the three systems: `/home/…`, `C:\…` (or `C:/…`), or `\\server\share\…`. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]/.test(path)
}

function isFilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') &&
    isAbsolutePath(value)
  )
}

/**
 * What no file name holds on each system. macOS and Linux refuse only `/` and NUL, so a backslash
 * or a newline is a legal part of a name there; Windows also refuses `\`, `:` and the control
 * characters.
 */
// eslint-disable-next-line no-control-regex
const WINDOWS_NAME_FORBIDS = /[/\\:\u0000-\u001f]/
// eslint-disable-next-line no-control-regex
const POSIX_NAME_FORBIDS = /[/\u0000]/

/** A file name such as `fib.sight` on `platform` (a process.platform): no folders, nothing odd. */
export function isFileName(value: unknown, platform: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_LENGTH)
    return false
  return !(platform === 'win32' ? WINDOWS_NAME_FORBIDS : POSIX_NAME_FORBIDS).test(value)
}

// --- page to main ----------------------------------------------------------------------------

export function parseSaveRequest(value: unknown): DesktopSaveRequest | null {
  const fields = fieldsOf(value)
  if (fields === null || !isProgramText(fields.source)) return null
  if (fields.path !== null && !isFilePath(fields.path)) return null
  return { source: fields.source, path: fields.path }
}

export function parseDocumentState(value: unknown, platform: string): DesktopDocumentState | null {
  const fields = fieldsOf(value)
  if (fields === null || typeof fields.dirty !== 'boolean') return null
  if (fields.name !== null && !isFileName(fields.name, platform)) return null
  return { name: fields.name, dirty: fields.dirty }
}

// --- main to page ----------------------------------------------------------------------------

export function parseCommand(value: unknown): DesktopCommand | null {
  return typeof value === 'string' && COMMANDS.has(value) ? (value as DesktopCommand) : null
}

/** A link fragment the app would accept from a `hindsight://open/` link. */
function isLinkFragment(value: unknown): value is string {
  return typeof value === 'string' && fragmentOfAppLink(`${APP_LINK_BASE}/${value}`) === value
}

export function parseOpenRequest(value: unknown, platform: string): DesktopOpenRequest | null {
  const fields = fieldsOf(value)
  if (fields === null) return null
  switch (fields.kind) {
    case 'program':
      return isProgramText(fields.source) &&
        isFilePath(fields.path) &&
        isFileName(fields.name, platform)
        ? { kind: 'program', source: fields.source, path: fields.path, name: fields.name }
        : null
    case 'trace':
      return fields.bytes instanceof Uint8Array && isFileName(fields.name, platform)
        ? { kind: 'trace', bytes: fields.bytes, name: fields.name }
        : null
    case 'link':
      return isLinkFragment(fields.fragment) ? { kind: 'link', fragment: fields.fragment } : null
    default:
      return null
  }
}

const MALFORMED_REPLY: DesktopSaveResult = {
  ok: false,
  reason: 'failed',
  message: 'The app sent an unexpected reply to the save.',
}

/** The main process's answer to a save, checked; anything unexpected becomes a failed save. */
export function parseSaveResult(value: unknown, platform: string): DesktopSaveResult {
  const fields = fieldsOf(value)
  if (fields === null) return MALFORMED_REPLY
  if (fields.ok === true) {
    return isFilePath(fields.path) && isFileName(fields.name, platform)
      ? { ok: true, path: fields.path, name: fields.name }
      : MALFORMED_REPLY
  }
  if (fields.ok !== false) return MALFORMED_REPLY
  if (fields.reason === 'cancelled') return { ok: false, reason: 'cancelled' }
  return fields.reason === 'failed' && typeof fields.message === 'string'
    ? { ok: false, reason: 'failed', message: fields.message }
    : MALFORMED_REPLY
}

// --- what the preload knows about the app -----------------------------------------------------

/**
 * The app's version reaches the sandboxed preload as a command-line switch of its renderer
 * (webPreferences.additionalArguments), which the preload can read synchronously.
 */
export const VERSION_SWITCH = '--hindsight-version='

const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,64})?$/
const UNKNOWN_VERSION = '0.0.0'

export function versionSwitch(version: string): string {
  return `${VERSION_SWITCH}${version}`
}

export function versionFromArgv(argv: readonly string[]): string {
  const value = argv.find((arg) => arg.startsWith(VERSION_SWITCH))?.slice(VERSION_SWITCH.length)
  return value !== undefined && VERSION_PATTERN.test(value) ? value : UNKNOWN_VERSION
}

export function platformOf(platform: string): DesktopBridge['platform'] {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux'
}
