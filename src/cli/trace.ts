/**
 * Trace files in the CLI (ARCHITECTURE §7.15, §9): `record` saves a run as a `.sighttrace` file,
 * and `loadTrace` opens one for the commands that accept it (run, replay, why, whynot, slice,
 * query): the program is recorded again with the saved seed, step limit and what-if edits, and a
 * replay that differs from the saved run is reported as a warning.
 */
import { basename } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  type ByteCodec,
  encodeTraceFileSync,
  openTraceFileSync,
  type Outcome,
  record,
  type Recording,
  traceBundle,
} from '../core/index'
import type { Command } from './args'
import type { ExitCode, Loaded } from './commands'
import { sanitize, type Style } from './format'
import type { CliIO } from './io'
import { VERSION } from './version'

const gzip: ByteCodec = (bytes) => gzipSync(bytes)
const gunzip: ByteCodec = (bytes, maxBytes) => gunzipSync(bytes, { maxOutputLength: maxBytes })

const count = (n: number) => n.toLocaleString('en-US')

/** `prog.sight` → `prog.sighttrace`; any other name gets the extension added. */
export function defaultTracePath(file: string): string {
  return /\.sight$/i.test(file)
    ? `${file.slice(0, -'.sight'.length)}.sighttrace`
    : `${file}.sighttrace`
}

function fail(io: CliIO, style: Style, message: string): null {
  io.stderr(`${style.error('error')}: ${sanitize(message)}\n`)
  return null
}

/** The loaded trace's run, or a new recording of the loaded program. */
export function recordingFor(
  loaded: Loaded,
  options: { readonly maxSteps: number; readonly seed: number },
): Recording {
  return loaded.recording ?? record(loaded.program, options)
}

/** Opens a trace file, or prints why it cannot be opened and returns null. */
export function loadTrace(io: CliIO, style: Style, file: string): Loaded | null {
  if (!io.readBytes) return fail(io, style, 'trace files cannot be read here')
  let bytes: Uint8Array
  try {
    bytes = io.readBytes(file)
  } catch (error) {
    return fail(io, style, `cannot read '${file}': ${(error as Error).message}`)
  }
  const opened = openTraceFileSync(bytes, gunzip)
  if (!opened.ok) return fail(io, style, `${file}: ${opened.error}`)
  if (!opened.verification.verified)
    io.stderr(`${style.error('warning')}: ${sanitize(`${file}: ${opened.verification.message}`)}\n`)
  const edits = opened.bundle.edits.length
  if (edits > 0)
    io.stderr(
      `${style.dim(`note: ${sanitize(file)} is a what-if (${edits} edit${edits === 1 ? '' : 's'}); showing the what-if run`)}\n`,
    )
  return {
    file,
    source: opened.bundle.source,
    program: opened.recording.program,
    recording: opened.recording,
    traceTime: opened.time,
  }
}

function outcomeText(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'finished':
      return 'finished'
    case 'error':
      return `runtime error ${outcome.error.code}`
    default:
      return 'stopped at the step limit'
  }
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`
}

/** `hindsight record FILE [-o OUT]`: records the program and writes a trace file. */
export function recordTrace(
  io: CliIO,
  style: Style,
  loaded: Loaded,
  command: Extract<Command, { kind: 'record' }>,
): ExitCode {
  const out = command.out ?? defaultTracePath(loaded.file)
  if (out === loaded.file) {
    fail(io, style, `writing '${out}' would replace the program: choose another name with -o`)
    return 1
  }
  if (!io.writeBytes) {
    fail(io, style, 'trace files cannot be written here')
    return 1
  }
  const recording = record(loaded.program, { maxSteps: command.maxSteps, seed: command.seed })
  const title = basename(loaded.file).replace(/\.sight$/i, '')
  const bundle = traceBundle({
    recording,
    time: recording.length,
    hindsightVersion: VERSION,
    title,
  })
  const encoded = bundle.ok ? encodeTraceFileSync(bundle.bundle, gzip) : bundle
  if (!encoded.ok) {
    fail(io, style, `cannot save the trace: ${encoded.error}`)
    return 1
  }
  try {
    io.writeBytes(out, encoded.bytes)
  } catch (error) {
    fail(io, style, `cannot write '${out}': ${(error as Error).message}`)
    return 1
  }
  const lines = recording.outputs.length
  io.stdout(
    `${style.ok('recorded')} ${count(recording.length)} steps (${outcomeText(recording.outcome)}, ${count(lines)} output line${lines === 1 ? '' : 's'}) to ${sanitize(out)} ${style.dim(`(${sizeText(encoded.bytes.length)})`)}\n`,
  )
  return 0
}
