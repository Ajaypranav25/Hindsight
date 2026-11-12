/**
 * The bug finder (ARCHITECTURE §7.6): algorithmic debugging (Shapiro, 1982) over a recording's
 * call tree. The user judges calls ("average([88, 83, 79]) returned 54 — is that right?") and the
 * finder narrows the search, top-down, to a call that went wrong although every call it made
 * returned the right value: the function whose own code is wrong.
 *
 * States are immutable; every transition returns a new state. The current suspect is known (or
 * assumed) wrong. Two strategies choose the next question:
 *
 * - `top-down`: the suspect's children are asked in execution order; the first one judged wrong
 *   becomes the suspect; when none is left, the suspect is the verdict.
 * - `divide` (divide and query; Shapiro 1982, Hirunkitti 1993): every call still under suspicion
 *   is weighed by the number of such calls below it, and the question is the call whose weight is
 *   closest to half of the suspect's. "Wrong" makes it the suspect, "right" clears its whole
 *   subtree, so each answer halves the search as nearly as the tree allows: about log2(N)
 *   questions for N calls, however deep or wide the tree is.
 *
 * Answers are remembered by call key, so identical calls (common in recursion) are never asked
 * twice.
 */
import type { CallNode } from './calls'

export type Answer = 'right' | 'wrong' | 'unsure'
export type Certainty = 'certain' | 'likely'
export type Strategy = 'top-down' | 'divide'

/** What the finder needs from a call tree (`CallTree` provides it). */
export interface FinderTree {
  children(call: CallNode, options: { readonly justMyCode: boolean }): readonly CallNode[]
  /** Equal for identical calls; null when the call must not be taken for another. */
  keyOf(call: CallNode): string | null
  /** Calls in the call's subtree, itself included; counted through `children` when absent. */
  size?(call: CallNode, options: { readonly justMyCode: boolean }): number
}

/** A call judged not wrong during a `divide` search: its subtree is out of suspicion. */
export interface Cleared {
  readonly call: CallNode
  readonly unsure: boolean
}

export interface Judgment {
  readonly call: CallNode
  readonly answer: Answer
  /** Carried over from an identical call the user already judged. */
  readonly remembered: boolean
}

export interface FinderState {
  readonly tree: FinderTree
  readonly justMyCode: boolean
  readonly strategy: Strategy
  /** `divide`: the calls below the suspect judged right or unsure (their subtrees are cleared). */
  readonly cleared: readonly Cleared[]
  /** Where the search began: the whole program or a call the user said went wrong. */
  readonly start: CallNode
  /** The deepest call known to be wrong. */
  readonly suspect: CallNode
  /** Position of the next of the suspect's children to judge. */
  readonly next: number
  /** True once a child of the suspect was judged 'unsure'. */
  readonly unsure: boolean
  /** Answers by call key. */
  readonly memo: ReadonlyMap<string, Answer>
  /** Every judgment so far, the user's and the remembered ones, in order. */
  readonly judgments: readonly Judgment[]
  /** Questions the user has answered. */
  readonly asked: number
  /** The state before the user's last answer; null at the start. */
  readonly previous: FinderState | null
}

export type Verdict =
  | { readonly kind: 'found'; readonly call: CallNode; readonly certainty: Certainty }
  /** No verdict yet: a question is still open. */
  | { readonly kind: 'none' }

export interface FinderOptions {
  /** Never ask about library calls; ask about the user calls they make. Default true. */
  readonly justMyCode?: boolean
  /** How the next question is chosen. Default `top-down`. */
  readonly strategy?: Strategy
}

/** Begins a search below `from`, which is taken to be wrong (the root: the program misbehaves). */
export function startFinder(
  tree: FinderTree,
  from: CallNode,
  options: FinderOptions = {},
): FinderState {
  const key = tree.keyOf(from)
  const memo = new Map<string, Answer>(key === null ? [] : [[key, 'wrong']])
  return settle({
    tree,
    justMyCode: options.justMyCode ?? true,
    strategy: options.strategy ?? 'top-down',
    cleared: [],
    start: from,
    suspect: from,
    next: 0,
    unsure: false,
    memo,
    judgments: [],
    asked: 0,
    previous: null,
  })
}

/** The call to ask about next, or null when the search is over. */
export function question(state: FinderState): CallNode | null {
  if (state.strategy === 'divide') return halving(state)
  return state.tree.children(state.suspect, { justMyCode: state.justMyCode })[state.next] ?? null
}

/** The calls still under suspicion: the suspect and what is below it, less the cleared subtrees. */
export function remaining(state: FinderState): number {
  if (state.strategy === 'divide') return weight(state, state.suspect)
  const children = state.tree.children(state.suspect, { justMyCode: state.justMyCode })
  let total = 1
  for (let i = state.next; i < children.length; i++) total += sizeOf(state, children[i]!)
  return total
}

/** Judges the open question; does nothing when the search is over. */
export function answer(state: FinderState, given: Answer): FinderState {
  const call = question(state)
  if (call === null) return state
  const key = state.tree.keyOf(call)
  const memo = key === null ? state.memo : new Map(state.memo).set(key, given)
  const settled = settle({ ...state, memo }, { call, answer: given, remembered: false })
  return { ...settled, asked: state.asked + 1, previous: state }
}

/** The state before the user's last answer (the same state at the start). */
export function undo(state: FinderState): FinderState {
  return state.previous ?? state
}

export function verdict(state: FinderState): Verdict {
  if (question(state) !== null) return { kind: 'none' }
  return { kind: 'found', call: state.suspect, certainty: state.unsure ? 'likely' : 'certain' }
}

/**
 * Applies `first` (if given), then every remembered answer that applies to the questions that
 * follow, until a question needs the user or the search is over.
 */
function settle(state: FinderState, first?: Judgment): FinderState {
  const judgments = [...state.judgments]
  let { suspect, next, unsure, cleared } = state
  const position = (): FinderState => ({ ...state, suspect, next, unsure, cleared, judgments })
  let judgment = first ?? remembered(position())
  while (judgment !== null) {
    judgments.push(judgment)
    const { call } = judgment
    if (judgment.answer === 'wrong') {
      suspect = call
      next = 0
      // Only what was cleared below the new suspect still matters.
      cleared = cleared.filter((entry) => within(entry.call, call))
      unsure = cleared.some((entry) => entry.unsure)
    } else {
      next += 1
      unsure ||= judgment.answer === 'unsure'
      if (state.strategy === 'divide') {
        cleared = [...cleared, { call, unsure: judgment.answer === 'unsure' }]
      }
    }
    judgment = remembered(position())
  }
  return position()
}

// --- divide and query ---------------------------------------------------------------------------

function within(call: CallNode, ancestor: CallNode): boolean {
  return call.entry >= ancestor.entry && call.exit <= ancestor.exit && call.depth > ancestor.depth
}

const countedSizes = new WeakMap<FinderTree, Map<number, number>>()

/** The call's subtree size: from the tree when it knows, else counted through `children`. */
function sizeOf(state: FinderState, call: CallNode): number {
  const options = { justMyCode: state.justMyCode }
  const known = state.tree.size?.(call, options)
  if (known !== undefined) return known
  let sizes = countedSizes.get(state.tree)
  if (sizes === undefined) {
    sizes = new Map()
    countedSizes.set(state.tree, sizes)
  }
  const cached = sizes.get(call.id)
  if (cached !== undefined) return cached
  // An explicit work stack: call trees can be far deeper than the JavaScript stack allows.
  let total = 0
  const work = [call]
  while (work.length > 0) {
    const node = work.pop()!
    total += 1
    for (const child of state.tree.children(node, options)) work.push(child)
  }
  sizes.set(call.id, total)
  return total
}

/** The calls at and below `call` that are still under suspicion. */
function weight(state: FinderState, call: CallNode): number {
  let total = sizeOf(state, call)
  for (const entry of state.cleared) {
    if (within(entry.call, call)) total -= sizeOf(state, entry.call)
  }
  return total
}

const halvingQuestions = new WeakMap<FinderState, CallNode | null>()

/**
 * The call that splits the suspects most evenly. It lies on the heavy path (from the suspect,
 * always into the heaviest child): weights only fall along the path, so the search stops at the
 * first call at or below half. Ties go to the call that ran first.
 */
function halving(state: FinderState): CallNode | null {
  if (halvingQuestions.has(state)) return halvingQuestions.get(state) ?? null
  const options = { justMyCode: state.justMyCode }
  const cleared = new Set(state.cleared.map((entry) => entry.call.id))
  const half = weight(state, state.suspect) / 2
  let best: CallNode | null = null
  let bestDistance = Infinity
  let node = state.suspect
  for (;;) {
    let heaviest: CallNode | null = null
    let heaviestWeight = 0
    for (const child of state.tree.children(node, options)) {
      if (cleared.has(child.id)) continue
      const childWeight = weight(state, child)
      if (childWeight > heaviestWeight) {
        heaviest = child
        heaviestWeight = childWeight
      }
    }
    if (heaviest === null) break
    const distance = Math.abs(heaviestWeight - half)
    if (distance < bestDistance) {
      best = heaviest
      bestDistance = distance
    }
    if (heaviestWeight <= half) break
    node = heaviest
  }
  halvingQuestions.set(state, best)
  return best
}

/** The remembered answer for the open question, if any. */
function remembered(state: FinderState): Judgment | null {
  const call = question(state)
  if (call === null) return null
  const key = state.tree.keyOf(call)
  const known = key === null ? undefined : state.memo.get(key)
  return known === undefined ? null : { call, answer: known, remembered: true }
}

export {
  callSignature,
  changeTexts,
  culpritText,
  linesText,
  outcomeText,
  questionText,
  verdictReason,
} from './bug-finder-text'
