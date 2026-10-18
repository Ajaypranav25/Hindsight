/** Test doubles for the studio store: a scripted engine and a minimal recording. */
import type {
  AsyncRecordOptions,
  CompileResult,
  Direction,
  Outcome,
  ProvenanceEvent,
  Recording,
  StateView,
  StepKind,
  WriteTarget,
} from '../../core/api-types'
import type { Program } from '../../core/bytecode'
import type { Diagnostic } from '../../core/diagnostics'
import type { Engine } from './types'

export interface FakeRecordingOptions {
  readonly length: number
  readonly depths?: readonly number[]
  readonly outcome?: Outcome
  /** Statement starts, used by `step(…, 'into', …)`. */
  readonly stmtTimes?: readonly number[]
  readonly origins?: ReadonlyMap<string, ProvenanceEvent>
  readonly breakpointHits?: ReadonlyMap<number, readonly number[]>
}

export function fakeProgram(source: string): Program {
  return { source } as unknown as Program
}

/** A recording whose navigation is driven by `stmtTimes` and `breakpointHits`. */
export function fakeRecording(options: FakeRecordingOptions): Recording {
  const n = options.length
  const depths = Int32Array.from(options.depths ?? new Array<number>(n).fill(0))
  const stmts = [...(options.stmtTimes ?? Array.from({ length: n }, (_, t) => t))].sort(
    (a, b) => a - b,
  )
  const forward = (t: number, times: readonly number[]) => times.find((s) => s > t) ?? n
  const backward = (t: number, times: readonly number[]) =>
    [...times].reverse().find((s) => s < t) ?? 0
  const recording: Recording = {
    program: fakeProgram(''),
    length: n,
    outcome: options.outcome ?? { kind: 'finished' },
    outputs: [],
    locationAt: () => null,
    depthAt: (t) => depths[t] ?? 0,
    depthSeries: () => depths,
    stateAt: (t) => ({ time: t }) as unknown as StateView,
    objectAt: () => null,
    outputCountAt: () => 0,
    step: (t: number, _kind: StepKind, direction: Direction) =>
      direction === 'forward' ? forward(t, stmts) : backward(t, stmts),
    continue: (t: number, direction: Direction, breakpoints: ReadonlySet<number>) => {
      const hits = [...breakpoints].flatMap((line) => options.breakpointHits?.get(line) ?? [])
      hits.sort((a, b) => a - b)
      return direction === 'forward' ? forward(t, hits) : backward(t, hits)
    },
    lineHits: () => [],
    lineHitCounts: () => new Map(),
    origin: (target: WriteTarget) => options.origins?.get(JSON.stringify(target)) ?? null,
    history: () => ({ events: [], total: 0, truncated: false }),
    allocationTime: () => null,
    extend: () => recording,
    extendAsync: async (extra: number) =>
      fakeRecording({ ...options, length: n + extra, outcome: { kind: 'finished' } }),
  }
  return recording
}

export interface ScriptedEngine extends Engine {
  readonly compiled: string[]
  readonly recorded: { source: string; options: AsyncRecordOptions }[]
  /** Resolves the oldest pending recordAsync with the given recording. */
  resolveNext(recording: Recording): Promise<void>
  readonly pendingCount: number
}

/** An engine whose compile fails when the source contains "ERROR" and whose recordings wait. */
export function scriptedEngine(): ScriptedEngine {
  const compiled: string[] = []
  const recorded: { source: string; options: AsyncRecordOptions }[] = []
  const pending: ((recording: Recording) => void)[] = []
  return {
    compiled,
    recorded,
    get pendingCount() {
      return pending.length
    },
    compile(source: string): CompileResult {
      compiled.push(source)
      if (source.includes('ERROR')) {
        const diagnostic: Diagnostic = {
          code: 'E020',
          severity: 'error',
          message: "undefined variable 'ERROR'",
          span: { start: source.indexOf('ERROR'), end: source.indexOf('ERROR') + 5 },
        }
        return { ok: false, diagnostics: [diagnostic] }
      }
      return { ok: true, program: fakeProgram(source), diagnostics: [] }
    },
    recordAsync(program: Program, options: AsyncRecordOptions): Promise<Recording> {
      recorded.push({ source: program.source, options })
      return new Promise((resolve) => pending.push(resolve))
    },
    async resolveNext(recording: Recording) {
      const resolve = pending.shift()
      if (!resolve) throw new Error('no pending recording')
      resolve(recording)
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}
