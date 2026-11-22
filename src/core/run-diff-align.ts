/**
 * Aligning the calls two runs made (ARCHITECTURE §7.14). The children of a matched pair of calls
 * are lined up with a longest common subsequence keyed on the function name. When a name repeats
 * (recursion, a loop of calls), the match is chosen by the calls' arguments and call-site lines,
 * read cheaply from the event log and the trace (no state seeks). Calls left over between two
 * matches are paired as a rename when one function exists only in the first program and the
 * other only in the second, consistently across the whole diff.
 */
import type { Program } from './bytecode'
import type { CallNode, CallTree } from './calls'
import { eventsBetween } from './events'

/** Above this many cells (after trimming the common ends) children are aligned greedily. */
export const MAX_PAIR_CELLS = 250_000
/** How far the greedy aligner looks ahead for a call of the same name. */
const LOOKAHEAD = 32
/** A matched name outweighs every tiebreak, so the number of matches is maximized first. */
const MATCH = 1024
const SAME_ARGUMENTS = 2
const SAME_SITE = 1
const PARAMETER_EVENTS = 64

export interface Alignment {
  /** Matched children in order; `renamed` when their functions have different names. */
  readonly pairs: readonly {
    readonly a: CallNode
    readonly b: CallNode
    readonly renamed: boolean
  }[]
  readonly onlyA: readonly CallNode[]
  readonly onlyB: readonly CallNode[]
}

/** Cheap facts about calls, for telling same-named calls apart. */
export class CallHints {
  private readonly argumentTexts = new Map<number, string>()
  private readonly sites = new Map<number, number>()

  constructor(readonly tree: CallTree) {}

  /** The primitive arguments, as the call's parameter declarations recorded them. */
  args(call: CallNode): string {
    let text = this.argumentTexts.get(call.entry)
    if (text === undefined) {
      const { events } = eventsBetween(
        this.tree.recording,
        Math.max(0, call.entry - 1),
        call.entry,
        PARAMETER_EVENTS,
      )
      text = events
        .filter((event) => event.kind === 'declare' && event.target.kind === 'local')
        .map((event) => {
          const value = event.value
          return value !== null && typeof value === 'object' ? '#' : JSON.stringify(value)
        })
        .join(',')
      this.argumentTexts.set(call.entry, text)
    }
    return text
  }

  /** The line of the instruction that made the call (-1 in library code). */
  site(call: CallNode): number {
    let line = this.sites.get(call.entry)
    if (line === undefined) {
      const location = call.entry > 0 ? this.tree.recording.locationAt(call.entry - 1) : null
      line = location !== null && location.source === 'main' ? location.line : -1
      this.sites.set(call.entry, line)
    }
    return line
  }
}

/** Function names that only one of two programs defines: the candidates for a rename. */
export class Renames {
  private readonly onlyA: ReadonlySet<string>
  private readonly onlyB: ReadonlySet<string>
  private readonly aToB = new Map<string, string>()
  private readonly bToA = new Map<string, string>()

  constructor(a: Program, b: Program) {
    const namesA = functionNames(a)
    const namesB = functionNames(b)
    this.onlyA = new Set([...namesA].filter((name) => !namesB.has(name)))
    this.onlyB = new Set([...namesB].filter((name) => !namesA.has(name)))
  }

  /** Pairs `nameA` with `nameB` when that is consistent with the renames seen so far. */
  pair(nameA: string, nameB: string): boolean {
    if (!this.onlyA.has(nameA) || !this.onlyB.has(nameB)) return false
    if ((this.aToB.get(nameA) ?? nameB) !== nameB || (this.bToA.get(nameB) ?? nameA) !== nameA) {
      return false
    }
    this.aToB.set(nameA, nameB)
    this.bToA.set(nameB, nameA)
    return true
  }

  /** The renames used, in the order they were first seen. */
  list(): { readonly from: string; readonly to: string }[] {
    return [...this.aToB].map(([from, to]) => ({ from, to }))
  }
}

function functionNames(program: Program): Set<string> {
  const names = new Set<string>()
  for (const proto of program.protos) {
    if (proto.debug.source === 'main' && proto.kind !== 'script' && proto.name !== null) {
      names.add(proto.name)
    }
  }
  return names
}

/** The work budget shared by every alignment of one diff. */
export interface AlignBudget {
  /** Cells left for exact (dynamic programming) alignments. */
  cells: number
}

type Op =
  | { readonly kind: 'match'; readonly i: number; readonly j: number }
  | {
      readonly kind: 'a'
      readonly i: number
    }
  | { readonly kind: 'b'; readonly j: number }

/** Lines up the children `a` (first run) and `b` (second run) of a matched pair. */
export function alignChildren(
  a: readonly CallNode[],
  b: readonly CallNode[],
  hintsA: CallHints,
  hintsB: CallHints,
  renames: Renames,
  budget: AlignBudget,
): Alignment {
  const strong = (i: number, j: number): boolean =>
    a[i]!.name === b[j]!.name && hintsA.args(a[i]!) === hintsB.args(b[j]!)
  let start = 0
  while (start < a.length && start < b.length && strong(start, start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && strong(endA - 1, endB - 1)) {
    endA--
    endB--
  }
  const ops: Op[] = []
  for (let k = 0; k < start; k++) ops.push({ kind: 'match', i: k, j: k })
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= Math.min(MAX_PAIR_CELLS, budget.cells)) {
    budget.cells -= n * m
    exact(a, b, start, endA, endB, hintsA, hintsB, ops)
  } else {
    greedy(a, b, start, endA, endB, ops)
  }
  for (let k = 0; endA + k < a.length; k++) ops.push({ kind: 'match', i: endA + k, j: endB + k })
  return withRenames(a, b, ops, renames)
}

/** A weighted LCS of the middles: most matches first, then the best tiebreaks. */
function exact(
  a: readonly CallNode[],
  b: readonly CallNode[],
  start: number,
  endA: number,
  endB: number,
  hintsA: CallHints,
  hintsB: CallHints,
  ops: Op[],
): void {
  const n = endA - start
  const m = endB - start
  const width = m + 1
  const score = (i: number, j: number): number => {
    const x = a[start + i]!
    const y = b[start + j]!
    if (x.name !== y.name) return -1
    return (
      MATCH +
      (hintsA.args(x) === hintsB.args(y) ? SAME_ARGUMENTS : 0) +
      (hintsA.site(x) === hintsB.site(y) ? SAME_SITE : 0)
    )
  }
  // best[i * width + j]: the best total for a[start + i ..] and b[start + j ..].
  const best = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(best[(i + 1) * width + j]!, best[i * width + j + 1]!)
      const s = score(i, j)
      best[i * width + j] = s < 0 ? skip : Math.max(skip, best[(i + 1) * width + j + 1]! + s)
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = score(i, j)
      if (s >= 0 && best[i * width + j] === best[(i + 1) * width + j + 1]! + s) {
        ops.push({ kind: 'match', i: start + i++, j: start + j++ })
        continue
      }
    }
    if (j >= m || (i < n && best[(i + 1) * width + j]! >= best[i * width + j + 1]!)) {
      ops.push({ kind: 'a', i: start + i++ })
    } else {
      ops.push({ kind: 'b', j: start + j++ })
    }
  }
}

/** Two pointers with a short lookahead: for middles too large to align exactly. */
function greedy(
  a: readonly CallNode[],
  b: readonly CallNode[],
  start: number,
  endA: number,
  endB: number,
  ops: Op[],
): void {
  let i = start
  let j = start
  const ahead = (list: readonly CallNode[], from: number, end: number, name: string): number => {
    for (let k = from; k < Math.min(end, from + LOOKAHEAD); k++)
      if (list[k]!.name === name) return k
    return -1
  }
  while (i < endA && j < endB) {
    if (a[i]!.name === b[j]!.name) {
      ops.push({ kind: 'match', i: i++, j: j++ })
      continue
    }
    const inB = ahead(b, j + 1, endB, a[i]!.name)
    const inA = ahead(a, i + 1, endA, b[j]!.name)
    if (inB >= 0 && (inA < 0 || inB - j <= inA - i)) {
      while (j < inB) ops.push({ kind: 'b', j: j++ })
    } else if (inA >= 0) {
      while (i < inA) ops.push({ kind: 'a', i: i++ })
    } else {
      ops.push({ kind: 'a', i: i++ })
      ops.push({ kind: 'b', j: j++ })
    }
  }
  while (i < endA) ops.push({ kind: 'a', i: i++ })
  while (j < endB) ops.push({ kind: 'b', j: j++ })
}

/** Turns the edit script into an alignment, pairing renamed functions inside each gap. */
function withRenames(
  a: readonly CallNode[],
  b: readonly CallNode[],
  ops: readonly Op[],
  renames: Renames,
): Alignment {
  const pairs: { a: CallNode; b: CallNode; renamed: boolean }[] = []
  const onlyA: CallNode[] = []
  const onlyB: CallNode[] = []
  let gapA: CallNode[] = []
  let gapB: CallNode[] = []
  const closeGap = (): void => {
    let k = 0
    while (k < gapA.length && k < gapB.length && renames.pair(gapA[k]!.name, gapB[k]!.name)) {
      pairs.push({ a: gapA[k]!, b: gapB[k]!, renamed: true })
      k++
    }
    onlyA.push(...gapA.slice(k))
    onlyB.push(...gapB.slice(k))
    gapA = []
    gapB = []
  }
  for (const op of ops) {
    if (op.kind === 'a') gapA.push(a[op.i]!)
    else if (op.kind === 'b') gapB.push(b[op.j]!)
    else {
      closeGap()
      pairs.push({ a: a[op.i]!, b: b[op.j]!, renamed: false })
    }
  }
  closeGap()
  return { pairs, onlyA, onlyB }
}
