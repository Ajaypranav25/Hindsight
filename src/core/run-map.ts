/**
 * The equivalent moment of another run (ARCHITECTURE §7.14): where a step of run `a` lands in run
 * `b`, typically the same program before and after an edit. The call running at the step is found
 * in `b` through the call-tree alignment of differential execution (only the calls on its path are
 * aligned, level by level), and inside that call the step is the n-th time the same line ran (the
 * line moved through a line diff of the two sources), at the same offset within the statement when
 * that still fits. When the call has no partner, the step that made the call in its nearest
 * matched caller stands in for it; when nothing matches, the step is clamped to the new run.
 *
 * Bounded: alignment visits only the ancestors of one call, uses the exact aligner for short
 * child lists and an ordinal match by name for long ones, and the line diff gives up on the
 * changed middle of very different sources. Never throws for steps inside `a`.
 */
import type { Recording } from './api-types'
import { type CallNode, type CallTree, callTree } from './calls'
import { alignChildren, CallHints, Renames } from './run-diff-align'

const JMC = { justMyCode: true } as const
/** Child lists longer than this (both runs together) are matched by name and position. */
const EXACT_CHILDREN = 4_000
/** Cells of exact alignment for one mapping. */
const MAP_CELLS = 2_000_000
/** Cells of the line diff's middle; past it, changed lines have no partner. */
const LINE_CELLS = 1_000_000

/**
 * How the moment was found. `line`: the same line's n-th run in the matching call. `nearest`:
 * that line ran fewer times there, so its last run. `beside`: the line was edited, so the
 * statement after the same run of the nearest earlier statement that was not. `call`: the
 * matching call's first step stands in. `clamped`: nothing matched; the step is kept as a number.
 * `end`: the end of `a` maps to the end of `b`.
 */
export type MomentPrecision = 'line' | 'nearest' | 'beside' | 'call' | 'clamped' | 'end'

export interface MappedMoment {
  readonly time: number
  readonly precision: MomentPrecision
  /** The function of the matched call the moment was found in (`<top level>` for the root). */
  readonly call: string
}

export interface MapMomentOptions {
  /**
   * Line numbers of `a`'s source in `b`'s (null when a line has no partner). Default: identity for
   * equal sources, else `lineMap(a's source, b's source)`.
   */
  readonly lines?: (line: number) => number | null
}

/** Where step `t` of run `a` lands in run `b` (see the module comment). */
export function mapMoment(
  a: Recording,
  b: Recording,
  t: number,
  options: MapMomentOptions = {},
): MappedMoment {
  const time = Math.max(0, Math.min(Number.isFinite(t) ? Math.trunc(t) : 0, a.length))
  if (time >= a.length) return { time: b.length, precision: 'end', call: '<top level>' }
  const treeA = callTree(a)
  const treeB = callTree(b)
  const target = treeA.callAt(time, JMC)
  const matched = matchPath(treeA, treeB, pathTo(treeA, target))
  const lines = options.lines ?? defaultLines(a.program.source, b.program.source)
  return momentIn(treeA, treeB, matched, target, time, lines)
}

/** The user calls from the root down to `call`. */
function pathTo(tree: CallTree, call: CallNode): CallNode[] {
  const path: CallNode[] = []
  for (let node: CallNode | null = call; node !== null; node = tree.parent(node, JMC)) {
    path.push(node)
  }
  return path.reverse()
}

interface MatchedPair {
  readonly a: CallNode
  readonly b: CallNode
}

/** The deepest call of `path` with a partner in `b`, aligning one level at a time. */
function matchPath(treeA: CallTree, treeB: CallTree, path: readonly CallNode[]): MatchedPair {
  const hintsA = new CallHints(treeA)
  const hintsB = new CallHints(treeB)
  const renames = new Renames(treeA.recording.program, treeB.recording.program)
  const budget = { cells: MAP_CELLS }
  let pair: MatchedPair = { a: treeA.root, b: treeB.root }
  for (let level = 1; level < path.length; level++) {
    const next = path[level]!
    const childrenA = treeA.children(pair.a, JMC)
    const childrenB = treeB.children(pair.b, JMC)
    let partner: CallNode | null
    if (childrenA.length + childrenB.length <= EXACT_CHILDREN) {
      const alignment = alignChildren(childrenA, childrenB, hintsA, hintsB, renames, budget)
      partner = alignment.pairs.find((p) => p.a.entry === next.entry)?.b ?? null
    } else {
      partner = byPosition(childrenA, childrenB, next)
    }
    if (partner === null) break
    pair = { a: next, b: partner }
  }
  return pair
}

/** The call of `b` with `call`'s name and its rank among the same-named calls of `a`. */
function byPosition(
  a: readonly CallNode[],
  b: readonly CallNode[],
  call: CallNode,
): CallNode | null {
  let rank = 0
  for (const sibling of a) {
    if (sibling.entry === call.entry) break
    if (sibling.name === call.name) rank += 1
  }
  for (const sibling of b) {
    if (sibling.name !== call.name) continue
    if (rank === 0) return sibling
    rank -= 1
  }
  return null
}

function momentIn(
  treeA: CallTree,
  treeB: CallTree,
  pair: MatchedPair,
  target: CallNode,
  time: number,
  lines: (line: number) => number | null,
): MappedMoment {
  const a = treeA.recording
  const b = treeB.recording
  const name = pair.a.depth === 0 ? '<top level>' : pair.a.name
  const fallback: MappedMoment =
    pair.a.depth === 0
      ? { time: Math.min(time, b.length), precision: 'clamped', call: name }
      : { time: pair.b.entry, precision: 'call', call: name }
  // The step in the matched call's own frame: the pen, or the step that made the call below it.
  const inner = a.depthAt(time) === pair.a.depth ? null : childAt(treeA, pair.a, time)
  const anchor = inner === null ? time : inner.entry - 1
  const location = a.locationAt(anchor)
  if (location === null || location.source !== 'main') return fallback
  const ownA = ownHits(a, a.lineHits(location.stmtLine), pair.a, anchor)
  const lineB = lines(location.stmtLine)
  const ownB = lineB === null ? [] : ownHits(b, b.lineHits(lineB), pair.b, pair.b.exit)
  if (ownA.length === 0 || lineB === null || ownB.length === 0) {
    const beside = besideChangedLine(a, b, pair, anchor, lines)
    return beside === null ? fallback : { time: beside, precision: 'beside', call: name }
  }
  const n = ownA.length
  const hit = ownB[Math.min(n, ownB.length) - 1]!
  const precision: MomentPrecision = n <= ownB.length ? 'line' : 'nearest'
  const step = sameStatementStep(b, hit, anchor - ownA[n - 1]!, lineB, pair.b)
  // Inside a library call of the matched call (with just-my-code, the pen's own call), follow it.
  if (inner !== null && pair.a.entry === target.entry) {
    const followed = intoCall(treeB, inner, step, time)
    if (followed !== null) return { time: followed, precision, call: name }
  }
  return { time: step, precision, call: name }
}

/** Statements looked back over for one whose line has a partner. */
const NEARBY_STATEMENTS = 16

/**
 * For a step whose line has no partner (it was edited): the statement after the same run of the
 * nearest earlier statement of the frame whose line has one; null when there is none close by.
 */
function besideChangedLine(
  a: Recording,
  b: Recording,
  pair: MatchedPair,
  anchor: number,
  lines: (line: number) => number | null,
): number | null {
  let u = anchor
  for (let k = 0; k < NEARBY_STATEMENTS; k++) {
    const previous = a.step(u, 'over', 'backward')
    if (previous >= u || previous < pair.a.entry || a.depthAt(previous) !== pair.a.depth) {
      return null
    }
    u = previous
    const location = a.locationAt(u)
    const lineB = location === null || location.source !== 'main' ? null : lines(location.stmtLine)
    if (location === null || lineB === null) continue
    const ownA = ownHits(a, a.lineHits(location.stmtLine), pair.a, u)
    const ownB = ownHits(b, b.lineHits(lineB), pair.b, pair.b.exit)
    if (ownA.length === 0 || ownB.length === 0) continue
    const hit = ownB[Math.min(ownA.length, ownB.length) - 1]!
    const next = b.step(hit, 'over', 'forward')
    return next <= pair.b.exit && b.depthAt(next) === pair.b.depth ? next : hit
  }
  return null
}

/** The direct child of `call` (any call, library ones included) that is running at `t`. */
function childAt(tree: CallTree, call: CallNode, t: number): CallNode | null {
  let node: CallNode | null = tree.callAt(t)
  while (node !== null) {
    const parent: CallNode | null = tree.parent(node)
    if (parent !== null && parent.entry === call.entry) return node
    node = parent
  }
  return null
}

/** The hits in `call`'s own frame up to `until`, from the sorted statement starts of a line. */
function ownHits(
  recording: Recording,
  hits: readonly number[],
  call: CallNode,
  until: number,
): number[] {
  const own: number[] = []
  for (let k = lowerBound(hits, call.entry); k < hits.length; k++) {
    const hit = hits[k]!
    if (hit > until || hit > call.exit) break
    if (recording.depthAt(hit) === call.depth) own.push(hit)
  }
  return own
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** `hit + offset` when that step is still the same statement in the same frame, else `hit`. */
function sameStatementStep(
  recording: Recording,
  hit: number,
  offset: number,
  line: number,
  call: CallNode,
): number {
  if (offset <= 0) return hit
  const step = hit + offset
  if (step > call.exit || step >= recording.length) return hit
  const location = recording.locationAt(step)
  const same =
    location !== null &&
    location.source === 'main' &&
    location.stmtLine === line &&
    recording.depthAt(step) === call.depth
  return same ? step : hit
}

/** The step of `b` inside the call made at `callStep` that matches `time` inside `inner`. */
function intoCall(treeB: CallTree, inner: CallNode, callStep: number, time: number): number | null {
  const callee = callStep + 1 <= treeB.recording.length ? treeB.call(callStep + 1) : null
  if (callee === null || callee.name !== inner.name) return null
  const offset = time - inner.entry
  return callee.entry + offset <= callee.exit ? callee.entry + offset : null
}

function defaultLines(a: string, b: string): (line: number) => number | null {
  return a === b ? (line) => line : lineMap(a, b)
}

/**
 * Maps 1-based lines of `before` to lines of `after`: the common start and end are matched
 * directly and the middle by a longest common subsequence of lines (when it is small enough);
 * lines without a partner map to null.
 */
export function lineMap(before: string, after: string): (line: number) => number | null {
  const a = before.split('\n')
  const b = after.split('\n')
  const map = new Int32Array(a.length).fill(-1)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    map[start] = start
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    map[endA - 1] = endB - 1
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= LINE_CELLS) matchMiddle(a, b, start, endA, endB, map)
  return (line) => {
    if (!Number.isInteger(line) || line < 1 || line > a.length) return null
    const index = map[line - 1]!
    return index < 0 ? null : index + 1
  }
}

/** An LCS of the lines `a[start..endA)` and `b[start..endB)`, written into `map`. */
function matchMiddle(
  a: readonly string[],
  b: readonly string[],
  start: number,
  endA: number,
  endB: number,
  map: Int32Array,
): void {
  const n = endA - start
  const m = endB - start
  const width = m + 1
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      map[start + i] = start + j
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i++
    } else {
      j++
    }
  }
}
