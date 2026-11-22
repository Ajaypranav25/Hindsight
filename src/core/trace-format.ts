/**
 * The `.sighttrace` format (ARCHITECTURE §7.15): the bundle a trace file holds and its limits.
 */
import type { TimedEdit } from './api-types'
import type { TraceCheckpoints } from './trace-hash'

export const TRACE_FORMAT = 'hindsight-trace'
export const TRACE_FORMAT_VERSION = 1
export const TRACE_FILE_EXTENSION = '.sighttrace'
/** The largest file `decodeTraceFile` reads. */
export const MAX_TRACE_FILE_BYTES = 32 * 1024 * 1024
/** The largest payload, after decompression. */
export const MAX_TRACE_PAYLOAD_BYTES = 64 * 1024 * 1024
/** Programs above this many characters are not stored (the MCP server's limit). */
export const MAX_TRACE_SOURCE_LENGTH = 200_000
/** The highest step limit a trace may ask for (the MCP server's cap). */
export const MAX_TRACE_STEPS = 10_000_000
/** The most what-if edits a trace replays (each one records a new future). */
export const MAX_TRACE_EDITS = 100

/** How a run ended, as a trace file summarizes it. */
export type TraceOutcome =
  | { readonly kind: 'finished' }
  | {
      readonly kind: 'error'
      readonly code: string
      readonly message: string
      /** 1-based line of the error's span. */
      readonly line: number
    }
  | { readonly kind: 'step-limit'; readonly maxSteps: number }
  | { readonly kind: 'aborted' }

/** The contents of a `.sighttrace` file. */
export interface TraceBundle {
  readonly format: typeof TRACE_FORMAT
  readonly version: typeof TRACE_FORMAT_VERSION
  /** The version of the Hindsight that wrote the file. */
  readonly hindsightVersion: string
  /** The program's name (an example title or a file name), when it has one. */
  readonly title: string | null
  readonly source: string
  readonly seed: number
  /** The real run's step limit. */
  readonly maxSteps: number
  /** The what-if chain, oldest first: each is a fork request on the run the previous one made. */
  readonly edits: readonly TimedEdit[]
  /** The step limit of the what-if forks (null when there are no edits). */
  readonly forkMaxSteps: number | null
  /** The pen: a step in `0..length` of the final run (the what-if when there are edits). */
  readonly time: number
  readonly outcome: TraceOutcome
  /** N of the final run. */
  readonly length: number
  /** The final run's output lines. */
  readonly output: readonly string[]
  readonly fingerprint: string
  readonly checkpoints: TraceCheckpoints
}
