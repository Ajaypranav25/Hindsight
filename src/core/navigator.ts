/**
 * Navigation over a recording (ARCHITECTURE §7.2): step into / over / out and continue, forwards and
 * backwards, with optional just-my-code, plus per-line hit lists. Linear scans over typed arrays.
 *
 * Candidates are the times 0..N-1; N (forward) and 0 (backward) are only fallbacks. Step over is
 * defined by activation: the running minimum depth between t and the candidate must not drop below
 * the candidate's depth, so a sibling call at the same depth is not the same frame.
 *
 * With tasks, steps only look at the steps of the task running at `t` (depths are per task), unless
 * asked to consider all; when that task has no qualifying step, forwards goes to the step after the
 * task's last step and backwards to the step before its first. `continue` stops in any task.
 */
import type { Direction, StepKind } from './api-types'
import type { ProtoTable } from './inspector-location'

const STMT = 1
const USER = 2

/** Per-step flags and statement lines, derived once from the trace. */
export class NavIndex {
  /** bit 0: statement start; bit 1: user code. */
  readonly flags: Uint8Array
  /** Statement line per step (0 for steps that are not user statement starts). */
  readonly lines: Int32Array
  private hitsByLine: Map<number, number[]> | null = null
  /** First and last step per task id (built on first use). */
  private spans: Map<number, { first: number; last: number }> | null = null

  constructor(
    /** Depth per step, length >= N. */
    readonly depths: Int32Array,
    readonly length: number,
    /** D(N). */
    readonly endDepth: number,
    protoIds: Int32Array,
    ips: Int32Array,
    table: ProtoTable,
    /** Running task per step (length >= N), or null without tasks. */
    readonly tasks: Int32Array | null = null,
    /** The task at N. */
    readonly endTask = 1,
  ) {
    this.flags = new Uint8Array(length)
    this.lines = new Int32Array(length)
    for (let t = 0; t < length; t++) {
      const proto = table.proto(protoIds[t]!)
      const ip = ips[t]!
      const user = proto.debug.source === 'main'
      const stmt = proto.debug.stmtStart[ip] === 1
      this.flags[t] = (stmt ? STMT : 0) | (user ? USER : 0)
      if (stmt && user) this.lines[t] = table.stmtLines(proto)[ip]!
    }
  }

  depth(t: number): number {
    return t < this.length ? this.depths[t]! : this.endDepth
  }

  /** The task running at `t` (1 without tasks). */
  task(t: number): number {
    if (this.tasks === null) return 1
    return t < this.length ? this.tasks[t]! : this.endTask
  }

  /** The first and last step of `task`, or null when it never ran. */
  span(task: number): { first: number; last: number } | null {
    if (this.spans === null) {
      const spans = new Map<number, { first: number; last: number }>()
      for (let t = 0; t < this.length; t++) {
        const id = this.task(t)
        const span = spans.get(id)
        if (span === undefined) spans.set(id, { first: t, last: t })
        else span.last = t
      }
      this.spans = spans
    }
    return this.spans.get(task) ?? null
  }

  lineHits(line: number): readonly number[] {
    return this.hits().get(line) ?? []
  }

  lineHitCounts(): ReadonlyMap<number, number> {
    const counts = new Map<number, number>()
    for (const [line, times] of this.hits()) counts.set(line, times.length)
    return counts
  }

  private hits(): Map<number, number[]> {
    if (this.hitsByLine === null) {
      const hits = new Map<number, number[]>()
      for (let t = 0; t < this.length; t++) {
        if (this.flags[t] !== (STMT | USER)) continue
        const line = this.lines[t]!
        const times = hits.get(line)
        if (times === undefined) hits.set(line, [t])
        else times.push(t)
      }
      this.hitsByLine = new Map([...hits.entries()].sort((a, b) => a[0] - b[0]))
    }
    return this.hitsByLine
  }
}

export function navigateStep(
  index: NavIndex,
  t: number,
  kind: StepKind,
  direction: Direction,
  justMyCode: boolean,
  allTasks = false,
): number {
  const forward = direction === 'forward'
  const task = allTasks || index.tasks === null ? null : index.task(t)
  switch (kind) {
    case 'into':
      return stepInto(index, t, forward, justMyCode, task)
    case 'over':
      return stepOver(index, t, forward, justMyCode, task)
    default:
      return stepOut(index, t, forward, justMyCode, task)
  }
}

/**
 * The fallback when no candidate qualifies: N forwards, 0 backwards; within a task, the step after
 * its last step (forwards) or before its first (backwards), when that lies beyond `t`.
 */
function fallback(index: NavIndex, t: number, forward: boolean, task: number | null): number {
  const span = task === null ? null : index.span(task)
  if (forward) return span !== null && span.last + 1 > t ? span.last + 1 : index.length
  return span !== null && span.first - 1 >= 0 && span.first - 1 < t ? span.first - 1 : 0
}

/** True when step `u` belongs to the task the navigation stays in (always, for null). */
function inTask(index: NavIndex, u: number, task: number | null): boolean {
  return task === null || index.tasks![u] === task
}

function stepInto(
  index: NavIndex,
  t: number,
  forward: boolean,
  jmc: boolean,
  task: number | null,
): number {
  const mask = jmc ? STMT | USER : STMT
  const flags = index.flags
  if (forward) {
    for (let u = t + 1; u < index.length; u++) {
      if ((flags[u]! & mask) === mask && inTask(index, u, task)) return u
    }
  } else {
    for (let u = Math.min(t, index.length) - 1; u >= 0; u--) {
      if ((flags[u]! & mask) === mask && inTask(index, u, task)) return u
    }
  }
  return fallback(index, t, forward, task)
}

function stepOver(
  index: NavIndex,
  t: number,
  forward: boolean,
  jmc: boolean,
  task: number | null,
): number {
  const mask = jmc ? STMT | USER : STMT
  const { flags, depths } = index
  const start = index.depth(t)
  let minimum = start
  const delta = forward ? 1 : -1
  for (
    let u = forward ? t + 1 : Math.min(t, index.length) - 1;
    u >= 0 && u < index.length;
    u += delta
  ) {
    if (!inTask(index, u, task)) continue
    const depth = depths[u]!
    if (depth < minimum) minimum = depth
    const f = flags[u]!
    // JMC: leaving the frame into library code (or, backwards, entering it from library code)
    // continues as a step into from that point (ARCHITECTURE §7.2).
    if (jmc && (f & USER) === 0 && depth < start) return stepInto(index, u, forward, true, task)
    if ((f & mask) === mask && depth <= start && minimum >= depth) return u
  }
  return fallback(index, t, forward, task)
}

function stepOut(
  index: NavIndex,
  t: number,
  forward: boolean,
  jmc: boolean,
  task: number | null,
): number {
  const { flags, depths } = index
  const start = index.depth(t)
  const qualifies = (u: number): boolean =>
    depths[u]! < start && (!jmc || (flags[u]! & USER) !== 0) && inTask(index, u, task)
  if (forward) {
    for (let u = t + 1; u < index.length; u++) if (qualifies(u)) return u
  } else {
    for (let u = Math.min(t, index.length) - 1; u >= 0; u--) if (qualifies(u)) return u
  }
  return fallback(index, t, forward, task)
}

export function navigateContinue(
  index: NavIndex,
  t: number,
  direction: Direction,
  breakpoints: ReadonlySet<number>,
): number {
  const { flags, lines } = index
  const want = STMT | USER
  if (direction === 'forward') {
    for (let u = t + 1; u < index.length; u++) {
      if (flags[u] === want && breakpoints.has(lines[u]!)) return u
    }
    return index.length
  }
  for (let u = Math.min(t, index.length) - 1; u >= 0; u--) {
    if (flags[u] === want && breakpoints.has(lines[u]!)) return u
  }
  return 0
}
