/**
 * The bug finder (ARCHITECTURE §7.6): algorithmic debugging (Shapiro, 1982) over a recording's
 * call tree. The user judges calls ("average([88, 83, 79]) returned 54 — is that right?") and the
 * finder narrows the search, top-down, to a call that went wrong although every call it made
 * returned the right value: the function whose own code is wrong.
 *
 * States are immutable; every transition returns a new state. The current suspect is known (or
 * assumed) wrong; its children are asked in execution order; the first one judged wrong becomes the
 * suspect; when none is left, the suspect is the verdict. Answers are remembered by call key, so
 * identical calls (common in recursion) are never asked twice.
 */
import type { CallNode } from './calls'

export type Answer = 'right' | 'wrong' | 'unsure'
export type Certainty = 'certain' | 'likely'

/** What the finder needs from a call tree (`CallTree` provides it). */
export interface FinderTree {
  children(call: CallNode, options: { readonly justMyCode: boolean }): readonly CallNode[]
  /** Equal for identical calls; null when the call must not be taken for another. */
  keyOf(call: CallNode): string | null
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
  return state.tree.children(state.suspect, { justMyCode: state.justMyCode })[state.next] ?? null
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
  let { suspect, next, unsure } = state
  const position = (): FinderState => ({ ...state, suspect, next, unsure, judgments })
  let judgment = first ?? remembered(position())
  while (judgment !== null) {
    judgments.push(judgment)
    if (judgment.answer === 'wrong') {
      suspect = judgment.call
      next = 0
      unsure = false
    } else {
      next += 1
      unsure ||= judgment.answer === 'unsure'
    }
    judgment = remembered(position())
  }
  return position()
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
