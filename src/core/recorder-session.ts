/**
 * The recording loop (ARCHITECTURE §7.1.1–7.1.4): per step, append the location to the trace, take a
 * snapshot when the cost-aware cadence says so, then execute the step. Shared by `record`,
 * `recordAsync`, `extend` and `extendAsync`; the async drivers run it in slices.
 */
import type { Outcome, OutputEvent, ScheduleOptions } from './api-types'
import type { Program } from './bytecode'
import { InternalError } from './diagnostics'
import type { RuntimeDeps, VM, VMSnapshot } from './runtime-types'
import { finishedOutcome } from './tasks-info'
import type { AllocTimes, EventColumns, StepColumns } from './trace-columns'
import type { TraceSink } from './trace-sink'

const INITIAL_INTERVAL = 256
/**
 * Replay between two snapshots may cost up to this many times what restoring one costs, so a seek
 * costs at most about three restores while snapshots stay rare for big heaps (§7.1.4).
 */
const RESTORE_FACTOR = 2
/** Thinning starts when the retained snapshots hold more values than this (§7.1.4). */
export const RETAINED_VALUES_LIMIT = 8_000_000

/**
 * Decides when a sliced run pauses (§7.1.7). The session calls `due` after every `interval` steps
 * it executes; `due` may change `interval`, so slow steps (a native scanning a huge list) are
 * followed by frequent checks while cheap ones keep checks rare.
 */
export interface Pacer {
  readonly interval: number
  /** True when the slice should end before the next step. */
  due(): boolean
}

export interface SnapshotEntry {
  readonly time: number
  readonly snapshot: VMSnapshot
  /** The values the snapshot copied (it drives the cadence). */
  readonly size: number
  /** A what-if fork's edited state at its fork step: never thinned (§7.5). */
  readonly pinned?: boolean
}

/**
 * The retained snapshots and the cadence state that decides when the next one is due. Distances
 * are measured in work (`VM.work`: steps plus the elements single steps allocate or visit), so a
 * step that sorts or scans a huge list counts for what it costs to replay (§7.1.4).
 */
export class SnapshotSchedule {
  private constructor(
    private entries: SnapshotEntry[],
    readonly budget: number,
    private interval: number,
    /** The work at which the next snapshot is due. */
    private nextWork: number,
    /** The values the retained snapshots hold, shared values counted once. */
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
      this.nextWork,
      this.retained,
    )
  }

  /**
   * The schedule of a what-if fork at `time` (§7.5): the snapshots before `time`, then the edited
   * state at `time` (taken from `vm`), pinned so that thinning keeps it. Every seek at or after
   * `time` then starts from the edited state, so a replay never runs the parent's unedited future.
   */
  forkAt(vm: VM, time: number): SnapshotSchedule {
    const snapshot = vm.snapshot()
    const entries = this.entries.filter((entry) => entry.time < time)
    entries.push({ time, snapshot, size: snapshot.size, pinned: true })
    const schedule = new SnapshotSchedule(entries, this.budget, this.interval, 0, 0)
    schedule.retained = retainedBy(entries)
    schedule.thin()
    schedule.scheduleAfter(vm.work, snapshot)
    return schedule
  }

  get list(): readonly SnapshotEntry[] {
    return this.entries
  }

  get currentInterval(): number {
    return this.interval
  }

  /** The work at which the next snapshot is due (compare with `VM.work`). */
  get next(): number {
    return this.nextWork
  }

  /** The values the retained snapshots hold, counting values they share once. */
  get retainedValues(): number {
    return this.retained
  }

  /** Snapshots the VM at `time` (unless one exists already) and applies the cadence rules. */
  take(vm: VM, time: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.time === time) this.scheduleAfter(vm.work, last.snapshot)
    else this.add(time, vm.snapshot(), vm.work)
  }

  /** Retains `snapshot`, taken at `time` after `work`, and schedules the next one. */
  add(time: number, snapshot: VMSnapshot, work: number): void {
    const last = this.entries[this.entries.length - 1]
    if (last === undefined || last.time < time) {
      this.entries.push({ time, snapshot, size: snapshot.size })
      this.retained += retainedSince(snapshot, last)
      this.thin()
    }
    this.scheduleAfter(work, snapshot)
  }

  /**
   * The next snapshot is due after at least `interval` work, four times the values this one
   * copied (so copying costs at most a quarter of the run) and twice what restoring it costs.
   */
  private scheduleAfter(work: number, snapshot: VMSnapshot): void {
    const gap = Math.max(
      this.interval,
      4 * snapshot.size,
      RESTORE_FACTOR * (snapshot.restoreSize ?? snapshot.size),
    )
    this.nextWork = nextMultiple(work + gap, this.interval)
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

  /**
   * Drops every other snapshot (keeping time 0 and pinned ones) and doubles the interval while
   * over budget.
   */
  private thin(): void {
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.budget || this.retained > RETAINED_VALUES_LIMIT)
    ) {
      const kept = this.entries.filter((entry, index) => index % 2 === 0 || entry.pinned === true)
      if (kept.length === this.entries.length) return
      this.entries = kept
      this.retained = retainedBy(kept)
      this.interval *= 2
    }
  }
}

/** The values `snapshot` holds beyond what the retained snapshot before it shares (§6.8). */
function retainedSince(snapshot: VMSnapshot, previous: SnapshotEntry | undefined): number {
  return snapshot.retainedSince?.(previous?.snapshot ?? null) ?? snapshot.size
}

/** The values a list of snapshots (in time order, each built on the ones before) holds. */
function retainedBy(entries: readonly SnapshotEntry[]): number {
  let total = 0
  for (let i = 0; i < entries.length; i++)
    total += retainedSince(entries[i]!.snapshot, entries[i - 1])
  return total
}

function nextMultiple(value: number, interval: number): number {
  return Math.ceil(value / interval) * interval
}

/** The location stored for time N (§7.1.3). */
export interface EndLocation {
  readonly protoId: number
  readonly ip: number
  readonly depth: number
  /** The task that failed or would run next. */
  readonly task: number
}

/** What a task that was switched away from does now: 0 runnable, 1 blocked, 2 done. */
function switchState(vm: VM, task: number): number {
  const status = vm.tasks?.[task - 1]?.status
  return status === 'blocked' ? 1 : status === 'done' ? 2 : 0
}

/** Everything a finished recording needs; shared buffers are read only below its own counts. */
export interface RecordingCore {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly seed: number
  /** How tasks interleaved (absent: round-robin); every VM replaying this run uses it. */
  readonly taskSchedule?: ScheduleOptions
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
  /**
   * Whether any of its steps ran with tasks (`steps.taskIds` may exist for a longer extension
   * sharing the columns, so this recording's own answer is kept).
   */
  readonly hasTasks: boolean
}

export interface SessionInit {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly seed: number
  readonly taskSchedule?: ScheduleOptions
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
   * Runs until the recording ends, or until `pacer` says the slice is over (it is asked after every
   * `pacer.interval` steps, so each slice makes progress). Returns the finished core, or null when
   * it paused.
   */
  run(pacer: Pacer | null): RecordingCore | null {
    if (this.core !== null) return this.core
    const { vm, steps, schedule, stopAt } = this.init
    let t = this.time
    let interval = pacer === null ? Infinity : pacer.interval
    let sinceCheck = 0
    for (;;) {
      if (t >= stopAt) return this.end(t, 'step-limit')
      if (sinceCheck >= interval) {
        sinceCheck = 0
        if (pacer!.due()) {
          this.time = t
          return null
        }
        interval = pacer!.interval
      }
      const frames = vm.frames
      const top = frames[frames.length - 1]!
      steps.set(t, top.closure.proto.id, top.ip, frames.length - 1)
      const tasks = vm.tasks !== null || steps.taskIds !== null
      const running = vm.taskId
      if (tasks) steps.setTask(t, running)
      if (vm.work >= schedule.next) schedule.take(vm, t)
      vm.step()
      if (vm.status === 'error') {
        this.init.sink.discardFrom(t)
        return this.end(t, 'error')
      }
      if (vm.taskId !== running) steps.addSwitch(t + 1, switchState(vm, running))
      t++
      sinceCheck++
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
        outcome = finishedOutcome(vm)
        break
      case 'error': {
        const error = vm.error
        if (error === null) throw new InternalError('the VM failed without an error')
        outcome = { kind: 'error', error }
        end = {
          protoId: steps.protoIds[length]!,
          ip: steps.ips[length]!,
          depth: steps.depths[length]!,
          task: steps.taskIds?.[length] ?? 1,
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
        end = {
          protoId: top.closure.proto.id,
          ip: top.ip,
          depth: frames.length - 1,
          task: vm.taskId,
        }
        endSnapshot = vm.snapshot()
        schedule.add(length, endSnapshot, vm.work)
      }
    }
    vm.hooks = null
    this.core = {
      program: this.init.program,
      runtime: this.init.runtime,
      seed: this.init.seed,
      taskSchedule: this.init.taskSchedule,
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
      hasTasks: steps.taskIds !== null,
    }
    return this.core
  }
}
