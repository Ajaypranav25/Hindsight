/**
 * `.sighttrace` files (ARCHITECTURE §7.15): a recorded moment as a file. The file holds the program
 * and everything needed to record it again (seed, step limit, the what-if edits), the pen, and a
 * fingerprint of the run, never the trace itself: the VM is deterministic, so opening a file
 * re-records it and checks the fingerprint (see `trace-open.ts`).
 *
 * Layout: the 8-byte magic `SIGHTTRC`, a little-endian u16 format version, a u8 of flags (bit 0:
 * the payload is gzip-compressed), then the payload: the bundle as UTF-8 JSON. Files are untrusted
 * input: every size is bounded and every field is validated into a fresh object (nothing from the
 * parsed JSON is spread or merged, so keys such as `__proto__` are inert).
 */
import type { EditValue } from './api-types'
import {
  MAX_TRACE_FILE_BYTES,
  MAX_TRACE_PAYLOAD_BYTES,
  TRACE_FORMAT_VERSION,
  type TraceBundle,
} from './trace-format'
import { validateBundle } from './trace-validate'

export * from './trace-format'
export { validateBundle } from './trace-validate'

const MAGIC = 'SIGHTTRC'
const HEADER_BYTES = MAGIC.length + 3
const FLAG_GZIP = 1

export type TraceDecodeResult =
  | { readonly ok: true; readonly bundle: TraceBundle }
  | { readonly ok: false; readonly error: string }

/** A synchronous gzip or gunzip (the CLI passes Node's zlib). Gunzip must enforce `maxBytes`. */
export type ByteCodec = (bytes: Uint8Array, maxBytes: number) => Uint8Array

// ---------------------------------------------------------------------------------------------
// Host facilities (reached through globalThis: the core has no DOM or Node types)

interface Utf8Encoder {
  encode(text: string): Uint8Array
}
interface Utf8Decoder {
  decode(bytes: Uint8Array): string
}
interface StreamReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(): Promise<void>
}
interface StreamWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}
interface ByteTransform {
  readonly readable: { getReader(): StreamReader }
  readonly writable: { getWriter(): StreamWriter }
}
type ByteTransformConstructor = new (format: 'gzip') => ByteTransform
type EncoderConstructor = new () => Utf8Encoder
type DecoderConstructor = new (label: 'utf-8', options: { fatal: boolean }) => Utf8Decoder

function hostValue<T>(name: string): T | null {
  const value = (globalThis as Record<string, unknown>)[name]
  return typeof value === 'function' ? (value as T) : null
}

function utf8Encode(text: string): Uint8Array {
  const Encoder = hostValue<EncoderConstructor>('TextEncoder')
  if (Encoder === null) throw new TraceFileError('this host has no TextEncoder')
  return new Encoder().encode(text)
}

function utf8Decode(bytes: Uint8Array): string {
  const Decoder = hostValue<DecoderConstructor>('TextDecoder')
  if (Decoder === null) throw new TraceFileError('this host has no TextDecoder')
  try {
    return new Decoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TraceFileError('the trace is not valid UTF-8')
  }
}

/** Whether this host can gzip and gunzip without help (CompressionStream). */
export function hasStreamCompression(): boolean {
  return (
    hostValue<ByteTransformConstructor>('CompressionStream') !== null &&
    hostValue<ByteTransformConstructor>('DecompressionStream') !== null
  )
}

/** Pipes `bytes` through a host stream; at most `maxBytes` come out. */
async function transform(
  name: 'CompressionStream' | 'DecompressionStream',
  bytes: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  const Transform = hostValue<ByteTransformConstructor>(name)
  if (Transform === null) throw new TraceFileError(`this host has no ${name}`)
  const stream = new Transform('gzip')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  // Written while reading, so a large payload never waits on a full queue.
  const writing = writer.write(bytes).then(() => writer.close())
  writing.catch(() => undefined)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new TraceFileError('the trace is too large once decompressed')
      }
      chunks.push(value)
    }
    await writing
  } catch (error) {
    if (error instanceof TraceFileError) throw error
    throw new TraceFileError('the compressed trace is damaged')
  }
  return concat(chunks, total)
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** A problem with a trace file's bytes or contents (caught and returned as an error result). */
class TraceFileError extends Error {}

// ---------------------------------------------------------------------------------------------
// Encoding

function header(flags: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES)
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i)
  bytes[MAGIC.length] = TRACE_FORMAT_VERSION & 0xff
  bytes[MAGIC.length + 1] = TRACE_FORMAT_VERSION >>> 8
  bytes[MAGIC.length + 2] = flags
  return bytes
}

/** Non-finite numbers and -0 do not survive JSON, so edit values tag them. */
function editValueJson(value: EditValue): unknown {
  if (typeof value !== 'number') return value
  if (Object.is(value, -0)) return { number: '-0' }
  return Number.isFinite(value) ? value : { number: String(value) }
}

/** The bundle as JSON text (validated first, so a bad bundle is never written). */
function payloadText(bundle: TraceBundle): string {
  const json = JSON.stringify(bundleJson(bundle))
  const checked = validateBundle(JSON.parse(json))
  if (typeof checked === 'string') throw new TraceFileError(`cannot save this trace: ${checked}`)
  return json
}

function bundleJson(bundle: TraceBundle): unknown {
  return {
    format: bundle.format,
    version: bundle.version,
    hindsightVersion: bundle.hindsightVersion,
    title: bundle.title,
    source: bundle.source,
    seed: bundle.seed,
    // Written only for the random policy, so round-robin files read as before tasks existed.
    ...(bundle.schedule === undefined ? {} : { schedule: bundle.schedule }),
    maxSteps: bundle.maxSteps,
    edits: bundle.edits.map((timed) => ({
      time: timed.time,
      edit: { target: timed.edit.target, value: editValueJson(timed.edit.value) },
    })),
    forkMaxSteps: bundle.forkMaxSteps,
    time: bundle.time,
    outcome: bundle.outcome,
    length: bundle.length,
    output: bundle.output,
    fingerprint: bundle.fingerprint,
    checkpoints: bundle.checkpoints,
  }
}

function assemble(flags: number, payload: Uint8Array): Uint8Array {
  if (HEADER_BYTES + payload.length > MAX_TRACE_FILE_BYTES)
    throw new TraceFileError('the trace is too large to save')
  const file = new Uint8Array(HEADER_BYTES + payload.length)
  file.set(header(flags))
  file.set(payload, HEADER_BYTES)
  return file
}

function plainPayload(bundle: TraceBundle): Uint8Array {
  const payload = utf8Encode(payloadText(bundle))
  if (payload.length > MAX_TRACE_PAYLOAD_BYTES)
    throw new TraceFileError('the trace is too large to save')
  return payload
}

export type TraceEncodeResult =
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string }

function encodeFailure(error: unknown): TraceEncodeResult {
  if (error instanceof TraceFileError) return { ok: false, error: error.message }
  throw error
}

/**
 * The file for `bundle`, gzip-compressed with the host's CompressionStream when there is one and
 * `compress` is not false; otherwise uncompressed.
 */
export async function encodeTraceFile(
  bundle: TraceBundle,
  options: { readonly compress?: boolean } = {},
): Promise<TraceEncodeResult> {
  try {
    const payload = plainPayload(bundle)
    if (options.compress === false || !hasStreamCompression())
      return { ok: true, bytes: assemble(0, payload) }
    const packed = await transform('CompressionStream', payload, MAX_TRACE_FILE_BYTES)
    return { ok: true, bytes: assemble(FLAG_GZIP, packed) }
  } catch (error) {
    return encodeFailure(error)
  }
}

/** `encodeTraceFile` without waiting: compressed with `gzip` when given, else uncompressed. */
export function encodeTraceFileSync(
  bundle: TraceBundle,
  gzip?: ByteCodec | null,
): TraceEncodeResult {
  try {
    const payload = plainPayload(bundle)
    if (!gzip) return { ok: true, bytes: assemble(0, payload) }
    return { ok: true, bytes: assemble(FLAG_GZIP, gzip(payload, MAX_TRACE_FILE_BYTES)) }
  } catch (error) {
    return encodeFailure(error)
  }
}

// ---------------------------------------------------------------------------------------------
// Decoding

interface Container {
  readonly compressed: boolean
  readonly payload: Uint8Array
}

function container(bytes: Uint8Array): Container {
  if (bytes.length > MAX_TRACE_FILE_BYTES) throw new TraceFileError('the file is too large')
  if (bytes.length < HEADER_BYTES || !hasMagic(bytes))
    throw new TraceFileError('this is not a Hindsight trace file')
  const version = bytes[MAGIC.length]! | (bytes[MAGIC.length + 1]! << 8)
  if (version > TRACE_FORMAT_VERSION)
    throw new TraceFileError(
      `this trace uses format version ${version}; this Hindsight reads version ${TRACE_FORMAT_VERSION}`,
    )
  if (version !== TRACE_FORMAT_VERSION)
    throw new TraceFileError(`unknown trace format version ${version}`)
  const flags = bytes[MAGIC.length + 2]!
  if ((flags & ~FLAG_GZIP) !== 0) throw new TraceFileError('the trace has unknown flags')
  return { compressed: (flags & FLAG_GZIP) !== 0, payload: bytes.subarray(HEADER_BYTES) }
}

function hasMagic(bytes: Uint8Array): boolean {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false
  return true
}

function bundleFromPayload(payload: Uint8Array): TraceBundle {
  if (payload.length > MAX_TRACE_PAYLOAD_BYTES)
    throw new TraceFileError('the trace is too large once decompressed')
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Decode(payload))
  } catch (error) {
    if (error instanceof TraceFileError) throw error
    throw new TraceFileError('the trace is damaged (its contents are not valid JSON)')
  }
  const bundle = validateBundle(parsed)
  if (typeof bundle === 'string') throw new TraceFileError(`the trace is invalid: ${bundle}`)
  return bundle
}

function decodeFailure(error: unknown): TraceDecodeResult {
  if (error instanceof TraceFileError) return { ok: false, error: error.message }
  throw error
}

/** Reads a `.sighttrace` file; a compressed one needs the host's DecompressionStream. */
export async function decodeTraceFile(bytes: Uint8Array): Promise<TraceDecodeResult> {
  try {
    const { compressed, payload } = container(bytes)
    const plain = compressed
      ? await transform('DecompressionStream', payload, MAX_TRACE_PAYLOAD_BYTES)
      : payload
    return { ok: true, bundle: bundleFromPayload(plain) }
  } catch (error) {
    return decodeFailure(error)
  }
}

/** `decodeTraceFile` without waiting; a compressed file needs `gunzip`. */
export function decodeTraceFileSync(
  bytes: Uint8Array,
  gunzip?: ByteCodec | null,
): TraceDecodeResult {
  try {
    const { compressed, payload } = container(bytes)
    if (!compressed) return { ok: true, bundle: bundleFromPayload(payload) }
    if (!gunzip) throw new TraceFileError('the trace is compressed and no decompressor was given')
    let plain: Uint8Array
    try {
      plain = gunzip(payload, MAX_TRACE_PAYLOAD_BYTES)
    } catch {
      throw new TraceFileError('the compressed trace is damaged or too large')
    }
    return { ok: true, bundle: bundleFromPayload(plain) }
  } catch (error) {
    return decodeFailure(error)
  }
}
