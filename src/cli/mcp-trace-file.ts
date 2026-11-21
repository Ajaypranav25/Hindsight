/**
 * Trace files over MCP (ARCHITECTURE §7.15, §9.1): `export_trace` saves a trace as a
 * `.sighttrace` file (returned as base64, so an agent can attach a recorded run to an issue), and
 * `open_trace` records the file's program again, re-applies its what-if edits, checks the
 * fingerprint and keeps the run as a new trace.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  type ByteCodec,
  encodeTraceFileSync,
  MAX_TRACE_FILE_BYTES,
  openTraceFileSync,
  traceBundle,
} from '../core/index'
import { traceSummary } from './mcp-tools'
import {
  type Args,
  type Json,
  schema,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
} from './mcp-shared'

const gzip: ByteCodec = (bytes) => gzipSync(bytes)
const gunzip: ByteCodec = (bytes, maxBytes) => gunzipSync(bytes, { maxOutputLength: maxBytes })

/** Base64 text longer than this cannot hold a file within MAX_TRACE_FILE_BYTES. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_TRACE_FILE_BYTES / 3) * 4 + 4

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '')
  if (clean.length > MAX_BASE64_LENGTH) throw new ToolError('trace_file is too large')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw new ToolError('trace_file must be base64 (the bytes of a .sighttrace file)')
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

function openTrace(context: ToolContext, args: Args): Json {
  const text = stringArg(args, 'trace_file')
  if (text === null) throw new ToolError('Give trace_file (a .sighttrace file as base64)')
  const opened = openTraceFileSync(decodeBase64(text), gunzip)
  if (!opened.ok) throw new ToolError(`The trace file cannot be opened: ${opened.error}`)
  const trace = context.keep(opened.bundle.source, opened.recording, null)
  return {
    ...traceSummary(trace, args),
    verified: opened.verification.verified,
    ...(opened.verification.verified ? {} : { verification: opened.verification.message }),
    saved_step: opened.time,
    what_if_edits: opened.bundle.edits.length,
    title: opened.bundle.title,
  }
}

function exportTrace(context: ToolContext, args: Args): Json {
  const trace = context.trace(args)
  const time = args.step === undefined ? trace.recording.length : context.step(args, trace)
  let base = null
  for (let id = trace.parent; id !== null;) {
    const parent = context.trace({ trace_id: id })
    base = parent.recording
    id = parent.parent
  }
  const bundled = traceBundle({
    recording: trace.recording,
    base,
    time,
    hindsightVersion: context.version,
    title: stringArg(args, 'title'),
  })
  if (!bundled.ok) throw new ToolError(bundled.error)
  const encoded = encodeTraceFileSync(bundled.bundle, gzip)
  if (!encoded.ok) throw new ToolError(encoded.error)
  return {
    trace_id: trace.id,
    step: time,
    bytes: encoded.bytes.length,
    fingerprint: bundled.bundle.fingerprint,
    file_name: 'run.sighttrace',
    trace_file: Buffer.from(encoded.bytes).toString('base64'),
    note: 'Save trace_file (base64) as a .sighttrace file; hindsight replay FILE.sighttrace, the studio (Open trace…) and open_trace all read it.',
  }
}

export function traceFileTools(context: ToolContext): Tool[] {
  return [
    {
      name: 'export_trace',
      description:
        'Save a trace as a .sighttrace file, returned as base64 (a few KB: the program, seed, step limit, what-if edits, the chosen step and a fingerprint of the run; the run itself is recorded again on opening). Use it to attach a recorded execution to a bug report or hand it to a person, who opens it with hindsight replay or the studio.',
      inputSchema: schema(
        {
          trace_id: TRACE_ID,
          step: {
            type: 'integer',
            minimum: 0,
            description: 'The moment to save (default: the end)',
          },
          title: { type: 'string', description: 'A title stored in the file' },
        },
        ['trace_id'],
      ),
      run: (args) => exportTrace(context, args),
    },
    {
      name: 'open_trace',
      description:
        'Open a .sighttrace file (base64 in trace_file): records its program again, re-applies its what-if edits, checks the run against the saved fingerprint and returns a trace_id like run_trace, plus saved_step (the moment the file was saved at) and verified (false when this Hindsight version replays it differently).',
      inputSchema: schema(
        { trace_file: { type: 'string', description: 'The file, base64-encoded' } },
        ['trace_file'],
      ),
      run: (args) => openTrace(context, args),
    },
  ]
}
