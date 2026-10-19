/**
 * The recorder (ARCHITECTURE §7.1): `record` and `recordAsync` run a program on a hooked VM and
 * return a `Recording` that answers time-travel queries through the navigator, provenance and
 * inspector modules.
 */
import {
  type AsyncRecordOptions,
  DEFAULT_MAX_STEPS,
  DEFAULT_SEED,
  type Direction,
  type HistoryResult,
  type HistoryWindow,
  type Location,
  type NavOptions,
  type ObjectView,
  type OutputEvent,
  type Outcome,
  type ProvenanceEvent,
  type RecordOptions,
  type Recording,
  type StateView,
  type StepKind,
  type WriteTarget,
} from './api-types'
import type { Program } from './bytecode'
import { InternalError } from './diagnostics'
import { buildStateView } from './inspector'
import { findReachable, objectView } from './inspector-heap'
import { ProtoTable, locationOf } from './inspector-location'
import { NavIndex, navigateContinue, navigateStep } from './navigator'
import { history, origin } from './provenance'
import { ProvenanceIndex } from './provenance-index'
import { runSliced } from './recorder-async'
import { LruCache, Seeker } from './recorder-seek'
import { type RecordingCore, RecordingSession, SnapshotSchedule } from './recorder-session'
import type { RuntimeDeps, VM } from './runtime-types'
import { AllocTimes, EventColumns, StepColumns } from './trace-columns'
import { TraceSink } from './trace-sink'

const DEFAULT_SNAPSHOT_BUDGET = 512
const DEFAULT_HEAP_LIMIT = 250
const VIEW_CACHE_SIZE = 16

export function record(
  program: Program,
  runtime: RuntimeDeps,
  options: RecordOptions = {},
): Recording {
  return new RecordedRun(startSession(program, runtime, options).run(null)!)
}

export async function recordAsync(
  program: Program,
  runtime: RuntimeDeps,
  options: AsyncRecordOptions = {},
): Promise<Recording> {
  return new RecordedRun(await runSliced(startSession(program, runtime, options), options))
}

function stepLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback
  if (Number.isNaN(limit) || limit < 0) throw new InternalError(`invalid step limit ${limit}`)
  return Math.floor(limit)
}

function newVM(program: Program, runtime: RuntimeDeps, seed: number): VM {
  return runtime.createVM(program, {
    builtins: runtime.builtins,
    libraryProtos: runtime.libraryProtos,
    seed,
  })
}

function startSession(
  program: Program,
  runtime: RuntimeDeps,
  options: RecordOptions,
): RecordingSession {
  const seed = options.seed ?? DEFAULT_SEED
  const maxSteps = stepLimit(options.maxSteps, DEFAULT_MAX_STEPS)
  const budget = Math.max(1, Math.floor(options.snapshotBudget ?? DEFAULT_SNAPSHOT_BUDGET))
  const events = new EventColumns()
  const allocs = new AllocTimes()
  const sink = new TraceSink(events, allocs, [], 0)
  const vm = newVM(program, runtime, seed)
  vm.hooks = sink
  return new RecordingSession({
    program,
    runtime,
    seed,
    heapLimit: options.heapLimit ?? DEFAULT_HEAP_LIMIT,
    steps: new StepColumns(),
    events,
    allocs,
    sink,
    schedule: SnapshotSchedule.start(budget),
    vm,
    start: 0,
    stopAt: maxSteps,
    maxSteps,
  })
}

/** Continues a paused recording from its snapshot at N in a fresh hooked VM (§7.1.8). */
function extensionSession(
  core: RecordingCore,
  extraSteps: number,
  options: RecordOptions,
): RecordingSession {
  const snapshot = core.endSnapshot
  if (snapshot === null) {
    throw new InternalError(`cannot extend a recording whose outcome is '${core.outcome.kind}'`)
  }
  const extra = stepLimit(extraSteps, 0)
  const sink = new TraceSink(core.events, core.allocs, core.outputs.slice(), core.eventCount)
  const vm = newVM(core.program, core.runtime, core.seed)
  vm.restore(snapshot)
  vm.hooks = sink
  return new RecordingSession({
    program: core.program,
    runtime: core.runtime,
    seed: core.seed,
    heapLimit: options.heapLimit ?? core.heapLimit,
    steps: core.steps,
    events: core.events,
    allocs: core.allocs,
    sink,
    schedule: core.schedule.clone(),
    vm,
    start: core.length,
    stopAt: core.length + extra,
    maxSteps: core.maxSteps + extra,
  })
}

class RecordedRun implements Recording {
  readonly program: Program
  readonly length: number
  readonly outcome: Outcome
  readonly outputs: readonly OutputEvent[]
  private readonly table: ProtoTable
  private readonly seeker: Seeker
  private readonly views = new LruCache<number, StateView>(VIEW_CACHE_SIZE)
  private navIndex: NavIndex | null = null
  private provenanceIndex: ProvenanceIndex | null = null

  constructor(private readonly core: RecordingCore) {
    this.program = core.program
    this.length = core.length
    this.outcome = core.outcome
    this.outputs = core.outputs
    this.table = new ProtoTable(core.program, core.runtime.libraryProtos)
    this.seeker = new Seeker(core.program, core.runtime, core.seed, core.schedule)
  }

  locationAt(t: number): Location | null {
    this.check(t)
    const { steps, end } = this.core
    if (t < this.length)
      return locationOf(this.table, steps.protoIds[t]!, steps.ips[t]!, steps.depths[t]!)
    return end === null ? null : locationOf(this.table, end.protoId, end.ip, end.depth)
  }

  depthAt(t: number): number {
    this.check(t)
    return t < this.length ? this.core.steps.depths[t]! : (this.core.end?.depth ?? 0)
  }

  depthSeries(): Int32Array {
    return this.core.steps.depths.subarray(0, this.length)
  }

  stateAt(t: number): StateView {
    this.check(t)
    const cached = this.views.get(t)
    if (cached !== undefined) return cached
    const vm = this.seeker.positionAt(t)
    const outcome = this.outcome
    const view = buildStateView(
      vm,
      { table: this.table, heapLimit: this.core.heapLimit },
      {
        time: t,
        location: this.locationAt(t),
        outputCount: this.outputCountAt(t),
        error: t === this.length && outcome.kind === 'error' ? outcome.error : null,
      },
    )
    this.views.set(t, view)
    return view
  }

  objectAt(
    t: number,
    id: number,
    range?: { readonly offset: number; readonly limit: number },
  ): ObjectView | null {
    this.check(t)
    const vm = this.seeker.positionAt(t)
    const object = findReachable(vm, id)
    return object === null ? null : objectView(vm, object, range)
  }

  outputCountAt(t: number): number {
    this.check(t)
    const outputs = this.outputs
    let lo = 0
    let hi = outputs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (outputs[mid]!.time < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  step(t: number, kind: StepKind, direction: Direction, options?: NavOptions): number {
    this.check(t)
    return navigateStep(this.nav(), t, kind, direction, options?.justMyCode ?? false)
  }

  continue(
    t: number,
    direction: Direction,
    breakpoints: ReadonlySet<number>,
    _options?: NavOptions,
  ): number {
    this.check(t)
    return navigateContinue(this.nav(), t, direction, breakpoints)
  }

  lineHits(line: number): readonly number[] {
    return this.nav().lineHits(line)
  }

  lineHitCounts(): ReadonlyMap<number, number> {
    return this.nav().lineHitCounts()
  }

  origin(target: WriteTarget, before: number): ProvenanceEvent | null {
    this.check(before)
    return origin(this.provenance(), target, before)
  }

  history(target: WriteTarget, at: number, window?: HistoryWindow): HistoryResult {
    this.check(at)
    return history(this.provenance(), this.core.steps, this.length, target, at, window)
  }

  allocationTime(objectId: number): number | null {
    return this.core.allocs.get(objectId, this.length)
  }

  extend(extraSteps: number): Recording {
    return new RecordedRun(extensionSession(this.core, extraSteps, {}).run(null)!)
  }

  async extendAsync(extraSteps: number, options: AsyncRecordOptions = {}): Promise<Recording> {
    const session = extensionSession(this.core, extraSteps, options)
    return new RecordedRun(await runSliced(session, options))
  }

  private check(t: number): void {
    if (!Number.isInteger(t) || t < 0 || t > this.length) {
      throw new InternalError(`time ${t} is outside 0..${this.length}`)
    }
  }

  private nav(): NavIndex {
    if (this.navIndex === null) {
      const { steps } = this.core
      this.navIndex = new NavIndex(
        steps.depths,
        this.length,
        this.core.end?.depth ?? 0,
        steps.protoIds,
        steps.ips,
        this.table,
      )
    }
    return this.navIndex
  }

  private provenance(): ProvenanceIndex {
    this.provenanceIndex ??= new ProvenanceIndex(this.core.events, this.core.eventCount)
    return this.provenanceIndex
  }
}
