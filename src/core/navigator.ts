/**
 * Navigation over a recording (ARCHITECTURE §7.2): step into / over / out and continue, forwards and
 * backwards, with optional just-my-code, plus per-line hit lists. Linear scans over typed arrays.
 *
 * Candidates are the times 0..N-1; N (forward) and 0 (backward) are only fallbacks. Step over is
 * defined by activation: the running minimum depth between t and the candidate must not drop below
 * the candidate's depth, so a sibling call at the same depth is not the same frame.
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

  constructor(
    /** Depth per step, length >= N. */
    readonly depths: Int32Array,
    readonly length: number,
    /** D(N). */
    readonly endDepth: number,
    protoIds: Int32Array,
    ips: Int32Array,
    table: ProtoTable,
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
): number {
  const forward = direction === 'forward'
  switch (kind) {
    case 'into':
      return stepInto(index, t, forward, justMyCode)
    case 'over':
      return stepOver(index, t, forward, justMyCode)
    default:
      return stepOut(index, t, forward, justMyCode)
  }
}

/** The fallback when no candidate qualifies: N forwards, 0 backwards. */
function fallback(index: NavIndex, forward: boolean): number {
  return forward ? index.length : 0
}

function stepInto(index: NavIndex, t: number, forward: boolean, jmc: boolean): number {
  const mask = jmc ? STMT | USER : STMT
  const flags = index.flags
  if (forward) {
    for (let u = t + 1; u < index.length; u++) if ((flags[u]! & mask) === mask) return u
  } else {
    for (let u = Math.min(t, index.length) - 1; u >= 0; u--) {
      if ((flags[u]! & mask) === mask) return u
    }
  }
  return fallback(index, forward)
}

function stepOver(index: NavIndex, t: number, forward: boolean, jmc: boolean): number {
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
    const depth = depths[u]!
    if (depth < minimum) minimum = depth
    const f = flags[u]!
    // JMC: leaving the frame into library code (or, backwards, entering it from library code)
    // continues as a step into from that point (ARCHITECTURE §7.2).
    if (jmc && (f & USER) === 0 && depth < start) return stepInto(index, u, forward, true)
    if ((f & mask) === mask && depth <= start && minimum >= depth) return u
  }
  return fallback(index, forward)
}

function stepOut(index: NavIndex, t: number, forward: boolean, jmc: boolean): number {
  const { flags, depths } = index
  const start = index.depth(t)
  if (forward) {
    for (let u = t + 1; u < index.length; u++) {
      if (depths[u]! < start && (!jmc || (flags[u]! & USER) !== 0)) return u
    }
  } else {
    for (let u = Math.min(t, index.length) - 1; u >= 0; u--) {
      if (depths[u]! < start && (!jmc || (flags[u]! & USER) !== 0)) return u
    }
  }
  return fallback(index, forward)
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
