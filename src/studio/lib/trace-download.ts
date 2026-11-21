/**
 * "Download trace" (ARCHITECTURE §7.14, §11.3): the run on display as a `.sighttrace` file, named
 * after the program, saved through a temporary object URL.
 */
import type { Recording } from '../../core/api-types'
import { encodeTraceFile, TRACE_FILE_EXTENSION, traceBundle } from '../../core/index'
import { version } from '../../../package.json'

/** The studio's version, written into the trace files it saves. */
export const STUDIO_VERSION: string = version

const MAX_NAME_LENGTH = 60

/** A program's `// title:` header comment (the gallery examples have one), or null. */
export function programTitle(source: string): string | null {
  return source.match(/^\/\/ title:[ \t]*(.+?)[ \t]*$/m)?.[1] ?? null
}

/** `Linked list` → `linked-list.sighttrace`; a program without a title gets `program`. */
export function traceFileName(title: string | null): string {
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-$/, '')
  return `${slug || 'program'}${TRACE_FILE_EXTENSION}`
}

export interface TraceDownloadInput {
  /** The run on display (a what-if fork during a what-if). */
  readonly recording: Recording
  /** The real run behind a what-if. */
  readonly base: Recording | null
  readonly time: number
}

export type TraceDownload =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly name: string }
  | { readonly ok: false; readonly error: string }

/** The trace file for the run on display, or why it cannot be saved. */
export async function traceDownload(input: TraceDownloadInput): Promise<TraceDownload> {
  const title = programTitle(input.recording.program.source)
  const bundle = traceBundle({
    recording: input.recording,
    base: input.base,
    time: input.time,
    hindsightVersion: STUDIO_VERSION,
    title,
  })
  if (!bundle.ok) return bundle
  const encoded = await encodeTraceFile(bundle.bundle)
  if (!encoded.ok) return encoded
  return { ok: true, bytes: encoded.bytes, name: traceFileName(title) }
}

/** The browser pieces a download uses (tests pass fakes). */
export interface DownloadHost {
  readonly document: Pick<Document, 'createElement' | 'body'>
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
  setTimeout(callback: () => void, ms: number): unknown
}

function browserHost(): DownloadHost {
  return {
    document,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  }
}

/** Saves `bytes` as a file called `name` (a click on a temporary download link). */
export function saveFile(
  bytes: Uint8Array,
  name: string,
  host: DownloadHost = browserHost(),
): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' })
  const url = host.createObjectURL(blob)
  const link = host.document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  link.hidden = true
  host.document.body.append(link)
  link.click()
  link.remove()
  // Revoked once the click has been handed to the browser's download machinery.
  host.setTimeout(() => host.revokeObjectURL(url), 1000)
}

/** True for a file the studio opens as a trace (by its name). */
export function isTraceFileName(name: string): boolean {
  return name.toLowerCase().endsWith(TRACE_FILE_EXTENSION)
}
