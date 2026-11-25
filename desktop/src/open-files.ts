/**
 * Turning a file on disk into what the studio opens: `.sighttrace` files are traces (bytes the
 * studio decodes and checks itself), anything else is a program (UTF-8 text). Files are untrusted:
 * both kinds are size-limited and a program that is not valid UTF-8 is refused, not mangled.
 */
import { basename, extname, join, resolve } from 'node:path'
import { MAX_TRACE_FILE_BYTES, TRACE_FILE_EXTENSION } from '../../src/core/trace-format'
import type { DesktopOpenRequest, DesktopSaveRequest } from '../../src/studio/desktop/bridge'
import { MAX_PROGRAM_BYTES, parseOpenRequest } from './messages'

export type FileKind = 'program' | 'trace'

export type OpenResult =
  | { readonly ok: true; readonly request: DesktopOpenRequest }
  | { readonly ok: false; readonly message: string }

export function fileKindOf(path: string): FileKind {
  return extname(path).toLowerCase() === TRACE_FILE_EXTENSION ? 'trace' : 'program'
}

/** The largest file of `kind` the app reads. */
export function sizeLimitOf(kind: FileKind): number {
  return kind === 'trace' ? MAX_TRACE_FILE_BYTES : MAX_PROGRAM_BYTES
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** Why a file of `size` bytes is not opened, or null when it is small enough. */
export function sizeProblem(path: string, size: number): string | null {
  const kind = fileKindOf(path)
  const limit = sizeLimitOf(kind)
  if (size <= limit) return null
  const what = kind === 'trace' ? 'Traces' : 'Programs'
  return `${basename(path)} is too large to open. ${what} can be at most ${megabytes(limit)}.`
}

/**
 * The open request for a file's contents on `platform` (a process.platform), or why it cannot be
 * opened. The request passes the same check the preload applies before the studio sees it, so a
 * file the studio would never get is an error the user sees, not a request dropped in silence.
 */
export function openRequestFor(path: string, bytes: Uint8Array, platform: string): OpenResult {
  const name = basename(path)
  const tooLarge = sizeProblem(path, bytes.length)
  if (tooLarge !== null) return { ok: false, message: tooLarge }
  if (fileKindOf(path) === 'trace') return checked({ kind: 'trace', bytes, name }, platform)
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      ok: false,
      message: `${name} is not a Hindsight program: it is not UTF-8 text.`,
    }
  }
  return checked({ kind: 'program', source, path, name }, platform)
}

type FileRequest = Exclude<DesktopOpenRequest, { readonly kind: 'link' }>

function checked(request: FileRequest, platform: string): OpenResult {
  if (parseOpenRequest(request, platform) !== null) return { ok: true, request }
  const name = JSON.stringify(request.name)
  return { ok: false, message: `${name} could not be opened because its name is not supported.` }
}

/**
 * The key a path is remembered under: Windows and macOS file systems ignore case (by default), so
 * `C:\Code\Fib.sight` and `c:\code\fib.sight` are the same file there.
 */
export function pathKey(path: string, platform: string): string {
  const absolute = resolve(path)
  return platform === 'linux' ? absolute : absolute.toLowerCase()
}

// --- dialogs and errors ----------------------------------------------------------------------

/** The name the Save dialog suggests for a program that has no file yet. */
export const DEFAULT_PROGRAM_NAME = 'program.sight'

/**
 * Where the Save dialog starts: the file the studio asked to write (one this session may not write
 * without asking), else the file it suggests (Save As on an opened file: that file), else a new
 * program in `folder` (the user's documents).
 */
export function saveDialogStart(
  request: Pick<DesktopSaveRequest, 'path' | 'suggestion'>,
  folder: string,
): string {
  return request.path ?? request.suggestion ?? join(folder, DEFAULT_PROGRAM_NAME)
}

export interface FileFilter {
  readonly name: string
  readonly extensions: string[]
}

export const OPEN_FILTERS: readonly FileFilter[] = [
  { name: 'Hindsight programs and traces', extensions: ['sight', 'sighttrace'] },
  { name: 'Hindsight programs', extensions: ['sight'] },
  { name: 'Hindsight traces', extensions: ['sighttrace'] },
  { name: 'All files', extensions: ['*'] },
]

export const SAVE_FILTERS: readonly FileFilter[] = [
  { name: 'Hindsight programs', extensions: ['sight'] },
]

const ERROR_REASONS: Readonly<Record<string, string>> = {
  ENOENT: 'it does not exist',
  EACCES: 'permission was denied',
  EPERM: 'permission was denied',
  EISDIR: 'it is a folder',
  EBUSY: 'it is in use by another program',
  ENOSPC: 'the disk is full',
  EROFS: 'the disk is read-only',
  ENAMETOOLONG: 'its name is too long',
}

/** A sentence-ending reason for a failed read or write, for the user. */
export function describeFileError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && ERROR_REASONS[code] !== undefined) return ERROR_REASONS[code]
  return error instanceof Error && error.message !== '' ? error.message : 'of an unknown error'
}
