/** What the bug-finder panel shows, computed from the interview (pure; no React). */
import {
  type CallDetails,
  type CallNode,
  callSignature,
  type CallTree,
  callTree,
  type Certainty,
  culpritText,
  type FinderState,
  InternalError,
  type LineSpan,
  LineIndex,
  outcomeText,
  question,
  questionText,
  type Recording,
  remaining,
  verdict,
  verdictReason,
} from '../../core/index'
import { type BugFinderSession, type BugFinderState, liveSession } from '../state/bug-finder'

/** A question the program's contracts or assertions answered, as the interview lists it. */
export interface AutomaticAnswerView {
  /** The call's id: a stable React key. */
  readonly id: number
  /** 1-based number of the question it answered. */
  readonly number: number
  /** `total(xs = [88, 83, 79]) returned 250` */
  readonly text: string
  readonly answer: 'right' | 'wrong'
  /** `the assertion on line 13` */
  readonly reason: string
  readonly line: number | null
}

interface InterviewSoFar {
  /** The questions contracts and assertions answered, in order. */
  readonly automatic: readonly AutomaticAnswerView[]
  /** Questions the user answered. */
  readonly asked: number
}

export type FinderView =
  | (InterviewSoFar & {
      readonly kind: 'question'
      readonly details: CallDetails
      /** 1-based number of the question (automatic answers count too). */
      readonly number: number
      /** Answers carried over from identical calls so far. */
      readonly remembered: number
      /** Calls still under suspicion, the suspect included. */
      readonly remaining: number
    })
  | (InterviewSoFar & {
      readonly kind: 'verdict'
      readonly details: CallDetails
      readonly certainty: Certainty
      /** "Found it: the bug is in average (lines 8–10)." */
      readonly headline: string
      /** "Every call it makes returned the right value, but its own result is wrong." */
      readonly reason: string
    })

/** Every automatic answer so far, numbered among all the questions (remembered answers are not). */
export function automaticAnswers(tree: CallTree, finder: FinderState): AutomaticAnswerView[] {
  const views: AutomaticAnswerView[] = []
  let number = 0
  for (const judgment of finder.judgments) {
    if (judgment.remembered) continue
    number += 1
    const { auto } = judgment
    if (auto === undefined) continue
    const details = tree.details(judgment.call)
    views.push({
      id: judgment.call.id,
      number,
      text: `${callSignature(details)} ${outcomeText(details)}`,
      answer: auto.answer,
      reason: auto.reason,
      line: auto.line,
    })
  }
  return views
}

export function finderView(session: BugFinderSession): FinderView {
  const tree = callTree(session.recording)
  const { finder } = session
  const call = question(finder)
  const soFar = { automatic: automaticAnswers(tree, finder), asked: finder.asked }
  if (call !== null) {
    const remembered = finder.judgments.filter((judgment) => judgment.remembered).length
    return {
      ...soFar,
      kind: 'question',
      details: tree.details(call),
      number: finder.asked + finder.answeredAutomatically + 1,
      remembered,
      remaining: remaining(finder),
    }
  }
  const result = verdict(finder)
  if (result.kind !== 'found') throw new InternalError('the search ended without a verdict')
  const details = tree.details(result.call)
  const calls = tree.children(result.call, { justMyCode: finder.justMyCode }).length
  const lead = result.certainty === 'certain' ? 'Found it' : 'Probably'
  return {
    ...soFar,
    kind: 'verdict',
    details,
    certainty: result.certainty,
    headline: `${lead}: the bug is in ${culpritText(details)}.`,
    reason: verdictReason(details, result.certainty, calls),
  }
}

/** Under a verdict: how many of the questions nobody had to answer. */
export function automaticSummary(asked: number, automatic: number): string | null {
  if (automatic === 0) return null
  const answers = automatic === 1 ? '1 question' : `${automatic} questions`
  if (asked === 0) return `No questions for you: your contracts and assertions answered ${answers}.`
  const yours = asked === 1 ? '1 question' : `${asked} questions`
  return `Your contracts and assertions answered ${answers}; you answered ${yours}.`
}

/** The sentence a screen reader hears when the panel changes. */
export function announcement(view: FinderView | null): string {
  if (view === null) return ''
  if (view.kind === 'question') return `Question ${view.number}: ${questionText(view.details)}`
  return `${view.headline} ${view.reason}`
}

/** Where "Show me" puts the pen: just after the call returned, or where the run stopped. */
export function afterCallTime(call: CallNode): number {
  return call.outcome === 'returned' ? call.exit + 1 : call.exit
}

/** The failed run's error, with its line in the main source; null when the run did not fail. */
export function runError(recording: Recording): { line: number; message: string } | null {
  if (recording.outcome.kind !== 'error') return null
  const { error } = recording.outcome
  return {
    line: new LineIndex(recording.program.source).lineOf(error.span.start),
    message: error.message,
  }
}

/** The user call the pen is in, if it is not the top level (a place to start the search). */
export function callAtPen(
  recording: Recording,
  time: number,
  justMyCode: boolean,
): CallNode | null {
  const clamped = Math.max(0, Math.min(time, recording.length))
  const call = callTree(recording).callAt(clamped, { justMyCode })
  return call.depth === 0 || call.library ? null : call
}

/** The lines of the function the bug finder found, while its verdict is showing. */
export function culpritLines(state: BugFinderState, recording: Recording | null): LineSpan | null {
  const session = liveSession(state, recording)
  if (session === null) return null
  const result = verdict(session.finder)
  return result.kind === 'found' ? callTree(session.recording).details(result.call).lines : null
}
