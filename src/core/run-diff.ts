/**
 * Differential execution (ARCHITECTURE §7.14): two recordings, of one program or of two versions
 * of it, compared by what they did rather than by their text. The calls are aligned by call tree
 * (`run-diff-align.ts`), matched calls are compared by inputs and behavior
 * (`run-diff-compare.ts`), and the report names the calls only one run made, the matched calls
 * that behaved differently and the **origins**: matched calls given the same inputs that behaved
 * differently while every call they made either behaved the same or was given different inputs
 * by them. An origin is where the change starts in a function's own code, found the way the bug
 * finder would find it (Shapiro, 1982), with the second run as the oracle instead of questions.
 *
 * The work is bounded and iterative: alignment visits at most `maxNodes` calls (breadth first,
 * so the top of the tree is aligned first) and at most `maxCompared` matched pairs are compared,
 * children of pairs that changed before the rest, so origins are found early in large runs.
 */
import type { Outcome, OutputDiffLine, Recording } from './api-types'
import { callSignature, changeTexts, outcomeText } from './bug-finder-text'
import { type CallNode, type CallTree, callTree, type LineSpan } from './calls'
import { diffOutputs } from './compare'
import { type AlignBudget, alignChildren, CallHints, Renames } from './run-diff-align'
import {
  type DiffAspect,
  differences,
  inputsDiffer,
  isBehavior,
  signatureOf,
} from './run-diff-compare'

export type { DiffAspect } from './run-diff-compare'

export const DEFAULT_DIFF_NODES = 200_000
export const DEFAULT_DIFF_COMPARED = 5_000
export const DEFAULT_DIFF_LIMIT = 50
/** Cells of exact alignment allowed in one diff; past it, children are aligned greedily. */
const ALIGN_CELLS = 20_000_000
const JMC = { justMyCode: true } as const

export interface RunDiffOptions {
  /** The most calls (of both runs together) aligned. Default 200,000. */
  readonly maxNodes?: number
  /** The most matched pairs compared by value. Default 5,000. */
  readonly maxCompared?: number
  /** The most entries listed per category (totals are always given). Default 50. */
  readonly limit?: number
}

/** A call of one of the runs, as the bug finder shows it. */
export interface DiffCall {
  /** A function name, `lambda`, or `<top level>`. */
  readonly name: string
  /** The call's first step in its run. */
  readonly entry: number
  readonly exit: number
  readonly depth: number
  /** `average(scores = [92, 88, 95])`; `the top-level code` for the root. */
  readonly signature: string
  /** `returned 91.66666666666667; global total became 3`. */
  readonly did: string
  /** The function's lines in its program. */
  readonly lines: LineSpan | null
}

export interface UnmatchedCall extends DiffCall {
  /** Calls in its subtree, itself included (none of them were matched). */
  readonly calls: number
}

export interface ChangedCall {
  readonly a: DiffCall
  readonly b: DiffCall
  /** The function has another name in the second program. */
  readonly renamed: boolean
  /** Given different arguments or captured/global values: the change may come from its caller. */
  readonly inputsChanged: boolean
  /** What differs (`calls`: some of the calls it made were made by one run only). */
  readonly changes: readonly DiffAspect[]
}

export interface OriginGroup extends ChangedCall {
  /** Identical origins (the same call doing the same things), common in recursion. */
  readonly count: number
}

export interface DiffList<T> {
  /** The first `limit` entries, in the order of the first run (`onlyB`: of the second). */
  readonly items: readonly T[]
  readonly total: number
}

export interface RunSummary {
  readonly steps: number
  readonly outcome: Outcome
  readonly outputs: number
  /** User-code calls, the top level included. */
  readonly calls: number
}

export interface RunDiff {
  readonly a: RunSummary
  readonly b: RunSummary
  /** The same outcome kind (and, for errors, the same code and message). */
  readonly sameOutcome: boolean
  readonly output: {
    readonly lines: readonly OutputDiffLine[]
    readonly removed: number
    readonly added: number
  }
  /** Top-most calls only the first run made (their subtrees are not listed). */
  readonly onlyA: DiffList<UnmatchedCall>
  readonly onlyB: DiffList<UnmatchedCall>
  readonly renamed: readonly { readonly from: string; readonly to: string }[]
  /** Matched calls that behaved differently or made different calls. */
  readonly changed: DiffList<ChangedCall>
  /** Where the changes start; `total` counts calls, `items` groups identical ones. */
  readonly origins: DiffList<OriginGroup>
  /** Matched pairs of calls (the top level included) and how many were compared. */
  readonly matched: number
  readonly compared: number
  readonly truncated: { readonly nodes: boolean; readonly compared: boolean }
  /** Nothing differs: outcome, output and every aligned and compared call. */
  readonly same: boolean
}

interface Pair {
  readonly a: CallNode
  readonly b: CallNode
  readonly renamed: boolean
  readonly parent: number
  /** Matched child pairs; null when the children were not aligned (the node budget ran out). */
  children: number[] | null
  unmatched: number
  /** This pair or one below it has calls only one run made. */
  structural: boolean
  compared: boolean
  changes: DiffAspect[]
  inputsChanged: boolean
  behaviorChanged: boolean
}

/** Compares run `a` with run `b` (two recordings, of one program or two). */
export function diffRuns(a: Recording, b: Recording, options: RunDiffOptions = {}): RunDiff {
  const limit = Math.max(0, options.limit ?? DEFAULT_DIFF_LIMIT)
  const treeA = callTree(a)
  const treeB = callTree(b)
  const aligned = align(treeA, treeB, options.maxNodes ?? DEFAULT_DIFF_NODES)
  const { pairs } = aligned
  const truncatedCompare = compare(
    treeA,
    treeB,
    pairs,
    options.maxCompared ?? DEFAULT_DIFF_COMPARED,
  )
  const changedPairs = pairs.filter((pair) => pair.compared && pair.changes.length > 0)
  changedPairs.sort((x, y) => x.a.entry - y.a.entry)
  const originPairs = changedPairs.filter((pair) => isOrigin(pairs, pair))
  const lines = diffOutputs(a.outputs, b.outputs)
  const removed = lines.filter((line) => line.kind === 'removed').length
  const added = lines.filter((line) => line.kind === 'added').length
  const sameOutcome = outcomesMatch(a.outcome, b.outcome)
  const unmatched = (tree: CallTree, calls: CallNode[]): DiffList<UnmatchedCall> => ({
    items: calls
      .sort((x, y) => x.entry - y.entry)
      .slice(0, limit)
      .map((call) => ({ ...diffCall(tree, call), calls: tree.size(call, JMC) })),
    total: calls.length,
  })
  return {
    a: summary(treeA),
    b: summary(treeB),
    sameOutcome,
    output: { lines, removed, added },
    onlyA: unmatched(treeA, aligned.onlyA),
    onlyB: unmatched(treeB, aligned.onlyB),
    renamed: aligned.renames.list(),
    changed: {
      items: changedPairs.slice(0, limit).map((pair) => changedCall(treeA, treeB, pair)),
      total: changedPairs.length,
    },
    origins: groupOrigins(treeA, treeB, originPairs, limit),
    matched: pairs.length,
    compared: pairs.filter((pair) => pair.compared).length,
    truncated: { nodes: aligned.truncated, compared: truncatedCompare },
    same:
      sameOutcome &&
      removed + added === 0 &&
      aligned.onlyA.length + aligned.onlyB.length === 0 &&
      changedPairs.length === 0,
  }
}

function outcomesMatch(x: Outcome, y: Outcome): boolean {
  if (x.kind !== y.kind) return false
  if (x.kind === 'error' && y.kind === 'error') {
    return x.error.code === y.error.code && x.error.message === y.error.message
  }
  return true
}

function summary(tree: CallTree): RunSummary {
  const { recording } = tree
  return {
    steps: recording.length,
    outcome: recording.outcome,
    outputs: recording.outputs.length,
    calls: tree.size(tree.root, JMC),
  }
}

// --- alignment ----------------------------------------------------------------------------------

interface Aligned {
  readonly pairs: Pair[]
  readonly onlyA: CallNode[]
  readonly onlyB: CallNode[]
  readonly renames: Renames
  readonly truncated: boolean
}

function newPair(a: CallNode, b: CallNode, renamed: boolean, parent: number): Pair {
  return {
    a,
    b,
    renamed,
    parent,
    children: null,
    unmatched: 0,
    structural: false,
    compared: false,
    changes: [],
    inputsChanged: false,
    behaviorChanged: false,
  }
}

/** Breadth-first over matched pairs: each pair's children are aligned once. */
function align(treeA: CallTree, treeB: CallTree, maxNodes: number): Aligned {
  const pairs = [newPair(treeA.root, treeB.root, false, -1)]
  const onlyA: CallNode[] = []
  const onlyB: CallNode[] = []
  const hintsA = new CallHints(treeA)
  const hintsB = new CallHints(treeB)
  const renames = new Renames(treeA.recording.program, treeB.recording.program)
  const budget: AlignBudget = { cells: ALIGN_CELLS }
  let nodes = 2
  let truncated = false
  for (let index = 0; index < pairs.length; index++) {
    const pair = pairs[index]!
    const childrenA = treeA.children(pair.a, JMC)
    const childrenB = treeB.children(pair.b, JMC)
    if (nodes + childrenA.length + childrenB.length > maxNodes) {
      truncated = true
      break
    }
    nodes += childrenA.length + childrenB.length
    const alignment = alignChildren(childrenA, childrenB, hintsA, hintsB, renames, budget)
    pair.children = alignment.pairs.map((child) => {
      pairs.push(newPair(child.a, child.b, child.renamed, index))
      return pairs.length - 1
    })
    pair.unmatched = alignment.onlyA.length + alignment.onlyB.length
    onlyA.push(...alignment.onlyA)
    onlyB.push(...alignment.onlyB)
  }
  // Children come after their parents, so one backward pass carries the flag up.
  for (let index = pairs.length - 1; index >= 0; index--) {
    const pair = pairs[index]!
    if (pair.unmatched > 0) pair.structural = true
    if (pair.structural && pair.parent >= 0) pairs[pair.parent]!.structural = true
  }
  return { pairs, onlyA, onlyB, renames, truncated }
}

// --- comparison ---------------------------------------------------------------------------------

/**
 * Compares pairs in three priority classes: children of pairs that changed (or with calls only
 * one run made below them) first, then children of pairs given different inputs, then the rest.
 * Returns true when the budget ran out with pairs left.
 */
function compare(treeA: CallTree, treeB: CallTree, pairs: Pair[], maxCompared: number): boolean {
  const queues: number[][] = [[0], [], []]
  const heads = [0, 0, 0]
  let compared = 0
  for (;;) {
    const level = queues.findIndex((queue, k) => heads[k]! < queue.length)
    if (level < 0) return false
    if (compared >= maxCompared) return true
    const pair = pairs[queues[level]![heads[level]!++]!]!
    const x = signatureOf(treeA, pair.a)
    const y = signatureOf(treeB, pair.b)
    compared += 1
    pair.compared = true
    pair.changes = differences(x, y)
    if (pair.unmatched > 0) pair.changes.push('calls')
    pair.inputsChanged = inputsDiffer(x, y)
    pair.behaviorChanged = pair.changes.some(isBehavior)
    const changedHere = !pair.inputsChanged && (pair.behaviorChanged || pair.unmatched > 0)
    for (const child of pair.children ?? []) {
      const next = changedHere || pairs[child]!.structural ? 0 : pair.inputsChanged ? 1 : 2
      queues[next]!.push(child)
    }
  }
}

/**
 * Given the same inputs, the pair behaved differently or made calls only one run made, while each
 * call it made behaved the same or was given different inputs (by this pair's own code).
 */
function isOrigin(pairs: readonly Pair[], pair: Pair): boolean {
  if (pair.children === null || pair.inputsChanged) return false
  if (!pair.behaviorChanged && pair.unmatched === 0) return false
  return pair.children.every((index) => {
    const child = pairs[index]!
    return child.compared && (!child.behaviorChanged || child.inputsChanged)
  })
}

// --- reports ------------------------------------------------------------------------------------

function diffCall(tree: CallTree, call: CallNode): DiffCall {
  const details = tree.details(call)
  return {
    name: call.depth === 0 ? '<top level>' : call.name,
    entry: call.entry,
    exit: call.exit,
    depth: call.depth,
    signature: callSignature(details),
    did: [outcomeText(details), ...changeTexts(details)].join('; '),
    lines: details.lines,
  }
}

function changedCall(treeA: CallTree, treeB: CallTree, pair: Pair): ChangedCall {
  return {
    a: diffCall(treeA, pair.a),
    b: diffCall(treeB, pair.b),
    renamed: pair.renamed,
    inputsChanged: pair.inputsChanged,
    changes: [...pair.changes],
  }
}

function groupOrigins(
  treeA: CallTree,
  treeB: CallTree,
  origins: readonly Pair[],
  limit: number,
): DiffList<OriginGroup> {
  const groups = new Map<string, { first: ChangedCall; count: number }>()
  for (const pair of origins) {
    const change = changedCall(treeA, treeB, pair)
    const key = [change.a.name, change.a.signature, change.a.did, change.b.did].join('\u0000')
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { first: change, count: 1 })
    else group.count += 1
  }
  const items = [...groups.values()]
    .slice(0, limit)
    .map((group) => ({ ...group.first, count: group.count }))
  return { items, total: origins.length }
}
