/**
 * The shape of every call in a recording with tasks (ARCHITECTURE §7.6). Depths are per task, so
 * each task's steps are read as a depth series of their own: a call begins at a step of its task
 * deeper than that task's previous step and ends at the task's first later step below its depth.
 * A spawned task's function call (its first step) is a child of the root, the whole program, next
 * to the main task's top-level calls in order of their first steps, and counts one level deeper
 * than its frame depth, so that depth 0 still means the root.
 *
 * Calls are numbered in pre-order of that tree (no longer entry order, since tasks interleave);
 * `indexOfEntry` and `innermostAt` search the calls in entry order instead. One pass over the
 * series plus an iterative walk, columnar like the single-task index.
 */
import type { CallShape } from './calls-index'

/** What the builder reads besides the depth series. */
export interface TaskSeries {
  /** Depth per step in the running task, length >= `length`. */
  readonly depths: Int32Array
  /** The running task per step, length >= `length`. */
  readonly tasks: Int32Array
  /** Steps recorded (N). */
  readonly length: number
  /** Depth and task at N (the failing or paused instruction; 0 and 1 when finished). */
  readonly endDepth: number
  readonly endTask: number
  /** Whether step `t` executes a `Return` (a task whose last step returns at depth 0 is done). */
  readonly returnsAt: (t: number) => boolean
}

interface TaskState {
  /** Open calls of the task (creation numbers), innermost last, with their frame depths. */
  readonly open: number[]
  readonly openDepths: number[]
  previous: number
  /** The task's latest step. */
  last: number
}

/** Calls in creation (entry) order while the series is read. */
class Created {
  readonly entries: number[] = []
  readonly parents: number[] = []
  readonly tasks: number[] = []
  readonly depths: number[] = []
  readonly exits: number[] = []
  readonly ends: number[] = []
  readonly returned: number[] = []

  open(entry: number, parent: number, task: number, depth: number): number {
    this.entries.push(entry)
    this.parents.push(parent)
    this.tasks.push(task)
    this.depths.push(depth)
    this.exits.push(-1)
    this.ends.push(-1)
    this.returned.push(0)
    return this.entries.length - 1
  }

  close(call: number, exit: number, end: number, returned: boolean): void {
    this.exits[call] = exit
    this.ends[call] = end
    this.returned[call] = returned ? 1 : 0
  }
}

export class TaskCallIndex implements CallShape {
  constructor(
    readonly count: number,
    readonly length: number,
    private readonly entries: Int32Array,
    private readonly ends: Int32Array,
    private readonly exits: Int32Array,
    private readonly parents: Int32Array,
    private readonly subtreeEnds: Int32Array,
    private readonly returned: Uint8Array,
    private readonly tasks: Int32Array,
    private readonly depths: Int32Array,
    /** Call numbers in entry order, with their entries (ascending). */
    private readonly byEntry: Int32Array,
    private readonly sortedEntries: Int32Array,
    /** Per task, its calls' positions in `byEntry` (ascending). */
    private readonly byTask: ReadonlyMap<number, Int32Array>,
    private readonly series: TaskSeries,
  ) {}

  entryOf(call: number): number {
    return this.entries[call]!
  }

  /** The first time after the call in its own task (the caller's next step), else N. */
  endOf(call: number): number {
    return this.ends[call]!
  }

  /** The call's last step (its `Return`) when it returned, else N. */
  exitOf(call: number): number {
    return this.exits[call]!
  }

  returnedOf(call: number): boolean {
    return this.returned[call] === 1
  }

  parentOf(call: number): number {
    return this.parents[call]!
  }

  subtreeEndOf(call: number): number {
    return this.subtreeEnds[call]!
  }

  taskOf(call: number): number {
    return this.tasks[call]!
  }

  /** Depth in the tree: the frame depth, plus one in spawned tasks. */
  depthOf(call: number): number {
    return this.depths[call]!
  }

  childrenOf(call: number): number[] {
    const children: number[] = []
    const last = this.subtreeEnds[call]!
    for (let child = call + 1; child < last; child = this.subtreeEnds[child]!) children.push(child)
    return children
  }

  indexOfEntry(t: number): number {
    const position = lastAtOrBefore(this.sortedEntries, t)
    return position >= 0 && this.sortedEntries[position] === t ? this.byEntry[position]! : -1
  }

  /** The innermost call of the task running at `t` that contains `t` (else the root). */
  innermostAt(t: number): number {
    const { series } = this
    const task = t < series.length ? series.tasks[t]! : series.endTask
    const positions = this.byTask.get(task)
    if (positions === undefined) return 0
    let low = 0
    let high = positions.length - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (this.sortedEntries[positions[middle]!]! <= t) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    if (found < 0) return 0
    let call = this.byEntry[positions[found]!]!
    while (call > 0 && !this.contains(call, t)) call = this.parents[call]!
    return call
  }

  private contains(call: number, t: number): boolean {
    const end = this.ends[call]!
    if (t < end) return true
    return end === this.length && !this.returnedOf(call)
  }
}

function lastAtOrBefore(sorted: Int32Array, t: number): number {
  let low = 0
  let high = sorted.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (sorted[middle]! <= t) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** Reads the series: every call with its task, parent, exit and end, in entry order. */
function readCalls(series: TaskSeries): Created {
  const { depths, tasks, length } = series
  const created = new Created()
  const states = new Map<number, TaskState>()
  created.open(0, -1, 1, 0)
  states.set(1, { open: [0], openDepths: [length > 0 ? depths[0]! : 0], previous: 0, last: -1 })
  const visit = (t: number, task: number, depth: number): void => {
    const state = states.get(task)
    if (state === undefined) {
      // A spawned task's first step: its function's call, under the root.
      const call = created.open(t, 0, task, depth + 1)
      states.set(task, { open: [call], openDepths: [depth], previous: depth, last: t })
      return
    }
    if (state.last < 0) state.previous = depth
    if (depth > state.previous) {
      const parent = state.open[state.open.length - 1]!
      state.open.push(created.open(t, parent, task, task === 1 ? depth : depth + 1))
      state.openDepths.push(depth)
    } else if (depth < state.previous) {
      while (state.open.length > 1 && state.openDepths[state.openDepths.length - 1]! > depth) {
        created.close(state.open.pop()!, state.last, t, true)
        state.openDepths.pop()
      }
    }
    state.previous = depth
    state.last = t
  }
  for (let t = 0; t < length; t++) visit(t, tasks[t]!, depths[t]!)
  if (length > 0) visit(length, series.endTask, series.endDepth)
  for (const [task, state] of states) {
    const done = task !== 1 && state.last < length && state.last >= 0 && taskReturned(series, state)
    for (let i = state.open.length - 1; i >= 0; i--) {
      const call = state.open[i]!
      if (i === 0 && done) created.close(call, state.last, state.last + 1, true)
      else created.close(call, length, length, false)
    }
  }
  return created
}

/** A spawned task is done when its last step is a `Return` from its function (depth 0). */
function taskReturned(series: TaskSeries, state: TaskState): boolean {
  return state.previous === 0 && state.open.length === 1 && series.returnsAt(state.last)
}

/** Indexes the calls of a recording with tasks. */
export function buildTaskCallIndex(series: TaskSeries): TaskCallIndex {
  const created = readCalls(series)
  const count = created.entries.length
  // Children in entry order, then a pre-order numbering with an explicit stack.
  const childLists: number[][] = Array.from({ length: count }, () => [])
  for (let call = 1; call < count; call++) childLists[created.parents[call]!]!.push(call)
  const number = new Int32Array(count)
  const subtreeEnds = new Int32Array(count)
  const order: number[] = []
  const work: number[] = [0]
  const exitMarks: number[] = []
  while (work.length > 0) {
    const call = work.pop()!
    if (call < 0) {
      subtreeEnds[number[exitMarks.pop()!]!] = order.length
      continue
    }
    number[call] = order.length
    order.push(call)
    exitMarks.push(call)
    work.push(-1)
    const children = childLists[call]!
    for (let i = children.length - 1; i >= 0; i--) work.push(children[i]!)
  }
  const column = (values: readonly number[]): Int32Array =>
    Int32Array.from(order, (call) => values[call]!)
  const parents = Int32Array.from(order, (call) => {
    const parent = created.parents[call]!
    return parent < 0 ? -1 : number[parent]!
  })
  const byTask = new Map<number, number[]>()
  for (let position = 0; position < count; position++) {
    const task = created.tasks[position]!
    const list = byTask.get(task)
    if (list === undefined) byTask.set(task, [position])
    else list.push(position)
  }
  return new TaskCallIndex(
    count,
    series.length,
    column(created.entries),
    column(created.ends),
    column(created.exits),
    parents,
    subtreeEnds,
    Uint8Array.from(order, (call) => created.returned[call]!),
    column(created.tasks),
    column(created.depths),
    Int32Array.from(number),
    Int32Array.from(created.entries),
    new Map([...byTask].map(([task, list]) => [task, Int32Array.from(list)])),
    series,
  )
}
