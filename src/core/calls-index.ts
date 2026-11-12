/**
 * The shape of every call in a recording (ARCHITECTURE §7.6), found in one pass over the depth
 * series: a call begins at a step whose depth exceeds the previous step's and ends at the first
 * later step whose depth is below its own (or at N). The depth at N (the failing or paused
 * instruction) counts too: calls deeper than it returned on the last recorded step, and a deeper
 * one is a call that failed on its very first step. Calls are numbered in entry order (a pre-order
 * walk of the call tree), with call 0 the root: the whole program. Storage is columnar, so millions
 * of steps index in a few milliseconds without an object per call.
 */

const INITIAL_CAPACITY = 64

class Column {
  data: Int32Array

  constructor(capacity: number) {
    this.data = new Int32Array(capacity)
  }

  set(index: number, value: number): void {
    if (index >= this.data.length) {
      let capacity = this.data.length * 2
      while (capacity <= index) capacity *= 2
      const grown = new Int32Array(capacity)
      grown.set(this.data)
      this.data = grown
    }
    this.data[index] = value
  }
}

export class CallIndex {
  constructor(
    /** Number of calls, the root included. */
    readonly count: number,
    /** Steps recorded (N). */
    readonly length: number,
    private readonly entries: Int32Array,
    private readonly ends: Int32Array,
    private readonly parents: Int32Array,
    /** One past the last call in each call's subtree (calls are in pre-order). */
    private readonly subtreeEnds: Int32Array,
    /** 1 when the call returned (its depth was left), 0 when it was still running at N. */
    private readonly returned: Uint8Array,
  ) {}

  /** The call's first step (0 for the root). */
  entryOf(call: number): number {
    return this.entries[call]!
  }

  /** The first step after the call (the caller's next step), or N when it never returned. */
  endOf(call: number): number {
    return this.ends[call]!
  }

  /** True when the call returned, possibly on the last recorded step. */
  returnedOf(call: number): boolean {
    return this.returned[call] === 1
  }

  /** The calling call, or -1 for the root. */
  parentOf(call: number): number {
    return this.parents[call]!
  }

  /** One past the last call of the call's subtree (calls are numbered in pre-order). */
  subtreeEndOf(call: number): number {
    return this.subtreeEnds[call]!
  }

  childrenOf(call: number): number[] {
    const children: number[] = []
    const last = this.subtreeEnds[call]!
    for (let child = call + 1; child < last; child = this.subtreeEnds[child]!) children.push(child)
    return children
  }

  /** The call that begins at step `t`, or -1. */
  indexOfEntry(t: number): number {
    const call = this.lastEntryAtOrBefore(t)
    return call >= 0 && this.entries[call] === t ? call : -1
  }

  /** The innermost call running at time `t` (calls still running at N contain N). */
  innermostAt(t: number): number {
    let call = Math.max(0, this.lastEntryAtOrBefore(t))
    while (
      call > 0 &&
      this.ends[call]! <= t &&
      (this.ends[call]! < this.length || this.returnedOf(call))
    ) {
      call = this.parents[call]!
    }
    return call
  }

  private lastEntryAtOrBefore(t: number): number {
    let low = 0
    let high = this.count - 1
    let found = -1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (this.entries[middle]! <= t) {
        found = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return found
  }
}

/**
 * Indexes the calls of a depth series of `length` steps (`Recording.depthSeries()`). `endDepth` is
 * the depth at N (`Recording.depthAt(N)`); by default the last step's, which changes nothing.
 */
export function buildCallIndex(depths: Int32Array, length: number, endDepth?: number): CallIndex {
  const entries = new Column(INITIAL_CAPACITY)
  const ends = new Column(INITIAL_CAPACITY)
  const parents = new Column(INITIAL_CAPACITY)
  const subtreeEnds = new Column(INITIAL_CAPACITY)
  const returned = new Column(INITIAL_CAPACITY)
  let count = 0
  const open = (entry: number, parent: number): number => {
    entries.set(count, entry)
    parents.set(count, parent)
    return count++
  }
  const close = (call: number, end: number, left: boolean): void => {
    ends.set(call, end)
    subtreeEnds.set(call, count)
    returned.set(call, left ? 1 : 0)
  }
  // The open calls, innermost last, with their depths.
  const stack: number[] = [open(0, -1)]
  const stackDepths: number[] = [length > 0 ? depths[0]! : 0]
  /** Moves to `depth` at step `t`: deeper opens a call, shallower closes the calls it left. */
  const step = (t: number, depth: number, previous: number): void => {
    if (depth > previous) {
      stack.push(open(t, stack[stack.length - 1]!))
      stackDepths.push(depth)
    } else if (depth < previous) {
      while (stack.length > 1 && stackDepths[stackDepths.length - 1]! > depth) {
        close(stack.pop()!, t, true)
        stackDepths.pop()
      }
    }
  }
  for (let t = 1; t < length; t++) step(t, depths[t]!, depths[t - 1]!)
  if (length > 0 && endDepth !== undefined) step(length, endDepth, depths[length - 1]!)
  while (stack.length > 0) close(stack.pop()!, length, false)
  return new CallIndex(
    count,
    length,
    entries.data.subarray(0, count),
    ends.data.subarray(0, count),
    parents.data.subarray(0, count),
    subtreeEnds.data.subarray(0, count),
    Uint8Array.from(returned.data.subarray(0, count)),
  )
}
