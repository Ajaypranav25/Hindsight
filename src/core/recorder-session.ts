/**
 * The recording loop (ARCHITECTURE §7.1.1–7.1.4): per step, append the location to the trace, take a
 * snapshot when the cost-aware cadence says so, then execute the step. Shared by `record`,
 * `recordAsync`, `extend` and `extendAsync`; the async drivers run it in slices.
 */
import type { Outcome, OutputEvent } from './api-types'
import type { Program } from './bytecode'
import { InternalError } from './diagnostics'
import type { RuntimeDeps, VM, VMSnapshot } from './runtime-types'
import type { AllocTimes, EventColumns, StepColumns } from './trace-columns'
import type { TraceSink } from './trace-sink'

const INITIAL_INTERVAL = 256
/** Thinning starts when the retained snapshots copied more values than this (§7.1.4). */
export const RETAINED_VALUES_LIMIT = 8_000_000
/** How many steps run between checks of the async slice deadline. */
const SLICE_CHECK_MASK = 1023

export interface SnapshotEntry {
  readonly time: number
  readonly snapshot: VMSnapshot
  readonly size: number
}

/** The retained snapshots and the cadence state that decides when the next one is due. */
export class SnapshotSchedule {
  private constructor(
    private entries: SnapshotEntry[],
    readonly budget: number,
    private interval: number,
    private nextTime: number,
    private retained: number,
  ) {}

  static start(budget: number): SnapshotSchedule {
    return new SnapshotSchedule([], budget, INITIAL_INTERVAL, 0, 0)
  }

  /** An independent copy (the list is copied before any later thinning, §7.1.8). */
  clone(): SnapshotSchedule {
    return new SnapshotSchedule(
      this.entries.slice(),
      this.budget,
      this.interval,
      this.nextTime,
      this.retained,
    )
  }

  get list(): readonly SnapshotEntry[] {
    return this.entries
  }

  get currentInterval(): number {
    return this.interval
  }

  get next(): number {
    return this.nextTime
  }

  /** Snapshots the VM at `time` (unless one exists already) and applies the cadence rules. */
  take(vm: VM, time: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.time === time) this.scheduleAfter(time, last.size)
    else this.add(time, vm.snapshot())
  }

  /** Retains `snapshot`, taken at `time`, and schedules the next one. */
  add(time: number, snapshot: VMSnapshot): void {
    const last = this.entries[this.entries.length - 1]
    if (last === undefined || last.time < time) {
      this.entries.push({ time, snapshot, size: snapshot.size })
      this.retained += snapshot.size
      this.thin()
    }
    this.scheduleAfter(time, snapshot.size)
  }

  private scheduleAfter(time: number, size: number): void {
    this.nextTime = nextMultiple(time + Math.max(this.interval, 4 * size), this.interval)
  }

  /** The latest snapshot at or before `time` (time 0 always exists). */
  latestAtOrBefore(time: number): SnapshotEntry {
    const entries = this.entries
    let lo = 0
    let hi = entries.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (entries[mid]!.time <= time) lo = mid
      else hi = mid - 1
    }
    const entry = entries[lo]
    if (entry === undefined || entry.time > time) {
      throw new InternalError(`no snapshot at or before time ${time}`)
    }
    return entry
  }

  /** Drops every other snapshot (keeping time 0) and doubles the interval while over budget. */
  private thin(): void {
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.budget || this.retained > RETAINED_VALUES_LIMIT)
    ) {
      this.entries = this.entries.filter((_, index) => index % 2 === 0)
      this.retained = this.entries.reduce((sum, entry) => sum + entry.size, 0)
      this.interval *= 2
    }
  }
}

function nextMultiple(value: number, interval: number): number {
  return Math.ceil(value / interval) * interval
}

/** The location stored for time N (§7.1.3). */
export interface EndLocation {
  readonly protoId: number
  readonly ip: number
  readonly depth: number
}

/** Everything a finished recording needs; shared buffers are read only below its own counts. */
export interface RecordingCore {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly seed: number
  readonly heapLimit: number
  readonly steps: StepColumns
  readonly events: EventColumns
  readonly allocs: AllocTimes
  readonly eventCount: number
  readonly outputs: readonly OutputEvent[]
  readonly length: number
  readonly outcome: Outcome
  readonly end: EndLocation | null
  readonly schedule: SnapshotSchedule
  /** The state at N for `step-limit` and `aborted` recordings (used by `extend`). */
  readonly endSnapshot: VMSnapshot | null
  /** The step limit this recording ran under (reported by `step-limit` outcomes). */
  readonly maxSteps: number
}

export interface SessionInit {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly seed: number
  readonly heapLimit: number
  readonly steps: StepColumns
  readonly events: EventColumns
  readonly allocs: AllocTimes
  readonly sink: TraceSink
  readonly schedule: SnapshotSchedule
  /** A VM with `sink` attached, positioned at `start`. */
  readonly vm: VM
  readonly start: number
  /** The run stops with `step-limit` when it reaches this time. */
  readonly stopAt: number
  /** The limit reported in a `step-limit` outcome. */
  readonly maxSteps: number
}

/** Runs a recording, possibly in slices, and produces its `RecordingCore`. */
export class RecordingSession {
  private time: number
  private core: RecordingCore | null = null

  constructor(private readonly init: SessionInit) {
    this.time = init.start
  }

  get currentTime(): number {
    return this.time
  }

  get done(): RecordingCore | null {
    return this.core
  }

  /**
   * Runs until the recording ends, or until `shouldYield` (polled every 1024 steps) returns true.
   * Returns the finished core, or null when it yielded.
   */
  run(shouldYield: (() => boolean) | null): RecordingCore | null {
    if (this.core !== null) return this.core
    const { vm, steps, schedule, stopAt } = this.init
    const sliceStart = this.time
    let t = this.time
    for (;;) {
      if (t >= stopAt) return this.end(t, 'step-limit')
      if (shouldYield !== null && t !== sliceStart && (t & SLICE_CHECK_MASK) === 0) {
        if (shouldYield()) {
          this.time = t
          return null
        }
      }
      const frames = vm.frames
      const top = frames[frames.length - 1]!
      steps.set(t, top.closure.proto.id, top.ip, frames.length - 1)
      if (t >= schedule.next) schedule.take(vm, t)
      vm.step()
      if (vm.status === 'error') {
        this.init.sink.discardFrom(t)
        return this.end(t, 'error')
      }
      t++
      if (vm.status === 'finished') return this.end(t, 'finished')
    }
  }

  /** Ends a sliced recording that was told to stop (outcome `aborted`). */
  abort(): RecordingCore {
    return this.core ?? this.end(this.time, 'aborted')
  }

  private end(length: number, kind: Outcome['kind']): RecordingCore {
    const { vm, sink, schedule, steps } = this.init
    this.time = length
    let end: EndLocation | null = null
    let endSnapshot: VMSnapshot | null = null
    let outcome: Outcome
    switch (kind) {
      case 'finished':
        outcome = { kind: 'finished' }
        break
      case 'error': {
        const error = vm.error
        if (error === null) throw new InternalError('the VM failed without an error')
        outcome = { kind: 'error', error }
        end = {
          protoId: steps.protoIds[length]!,
          ip: steps.ips[length]!,
          depth: steps.depths[length]!,
        }
        break
      }
      default: {
        outcome =
          kind === 'step-limit'
            ? { kind: 'step-limit', maxSteps: this.init.maxSteps }
            : { kind: 'aborted' }
        const frames = vm.frames
        const top = frames[frames.length - 1]!
        end = { protoId: top.closure.proto.id, ip: top.ip, depth: frames.length - 1 }
        endSnapshot = vm.snapshot()
        schedule.add(length, endSnapshot)
      }
    }
    vm.hooks = null
    this.core = {
      program: this.init.program,
      runtime: this.init.runtime,
      seed: this.init.seed,
      heapLimit: this.init.heapLimit,
      steps,
      events: this.init.events,
      allocs: this.init.allocs,
      eventCount: sink.eventCount,
      outputs: sink.outputs,
      length,
      outcome,
      end,
      schedule,
      endSnapshot,
      maxSteps: this.init.maxSteps,
    }
    return this.core
  }
}
