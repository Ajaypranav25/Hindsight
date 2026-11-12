/** What the bug-finder panel shows, computed from the interview (pure; no React). */
import {
  type CallDetails,
  type CallNode,
  callTree,
  type Certainty,
  culpritText,
  InternalError,
  type LineSpan,
  LineIndex,
  question,
  questionText,
  type Recording,
  remaining,
  verdict,
  verdictReason,
} from '../../core/index'
import { type BugFinderSession, type BugFinderState, liveSession } from '../state/bug-finder'

export type FinderView =
  | {
      readonly kind: 'question'
      readonly details: CallDetails
      /** 1-based number of the question. */
      readonly number: number
      /** Answers carried over from identical calls so far. */
      readonly remembered: number
      /** Calls still under suspicion, the suspect included. */
      readonly remaining: number
    }
  | {
      readonly kind: 'verdict'
      readonly details: CallDetails
      readonly certainty: Certainty
      /** "Found it: the bug is in average (lines 8–10)." */
      readonly headline: string
      /** "Every call it makes returned the right value, but its own result is wrong." */
      readonly reason: string
    }

export function finderView(session: BugFinderSession): FinderView {
  const tree = callTree(session.recording)
  const { finder } = session
  const call = question(finder)
  if (call !== null) {
    const remembered = finder.judgments.filter((judgment) => judgment.remembered).length
    return {
      kind: 'question',
      details: tree.details(call),
      number: finder.asked + 1,
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
    kind: 'verdict',
    details,
    certainty: result.certainty,
    headline: `${lead}: the bug is in ${culpritText(details)}.`,
    reason: verdictReason(details, result.certainty, calls),
  }
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
