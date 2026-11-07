/**
 * Sentences about calls and verdicts, shared by the studio and the CLI (ARCHITECTURE §7.6).
 * Texts are plain; callers escape them for their medium (the CLI sanitizes them for terminals).
 */
import type { Certainty } from './bug-finder'
import type { CallDetails, LineSpan } from './calls'

/** `average(xs = [88, 83, 79])`; the root reads `the top-level code`. */
export function callSignature(details: CallDetails): string {
  if (details.call.depth === 0) return 'the top-level code'
  const args = details.args.map((arg) => `${arg.name} = ${arg.text}`)
  return `${details.call.name}(${args.join(', ')})`
}

/** What the call did: `returned 125`, `raised an error: …`, or `was still running …`. */
export function outcomeText(details: CallDetails): string {
  switch (details.call.outcome) {
    case 'returned':
      return details.result === null ? 'finished' : `returned ${details.result.text}`
    case 'raised':
      return details.error === null
        ? 'raised an error'
        : `raised an error: ${details.error.message} (${details.error.code})`
    case 'unfinished':
      return 'was still running when the recording stopped'
  }
}

/** `xs became [5, 1]` for each argument the call changed. */
export function changeTexts(details: CallDetails): string[] {
  return details.args.flatMap((arg) =>
    arg.after === null ? [] : [`${arg.name} became ${arg.after}`],
  )
}

/** The question about a call, as one sentence. */
export function questionText(details: CallDetails): string {
  const changes = changeTexts(details)
  const effects = changes.length > 0 ? ` (${changes.join(', ')})` : ''
  return `${callSignature(details)} ${outcomeText(details)}${effects}. Is that right?`
}

/** `line 2` or `lines 8–10`. */
export function linesText(lines: LineSpan): string {
  return lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}–${lines.end}`
}

/** Where the bug is: `average (lines 8–10)` or `the top-level code (lines 1–14)`. */
export function culpritText(details: CallDetails): string {
  const name = details.call.depth === 0 ? 'the top-level code' : details.call.name
  return details.lines === null ? name : `${name} (${linesText(details.lines)})`
}

/**
 * Why the verdict points at the call: "Every call it makes returned the right value, but its own
 * result is wrong." `calls` is the number of calls it makes that the search could ask about.
 */
export function verdictReason(details: CallDetails, certainty: Certainty, calls: number): string {
  const lead =
    certainty === 'likely'
      ? 'None of the calls it makes was judged wrong'
      : calls === 0
        ? 'It makes no calls of its own'
        : 'Every call it makes returned the right value'
  const sentence =
    details.call.depth === 0
      ? `${lead}, so the mistake is in its own statements.`
      : `${lead}${calls === 0 && certainty === 'certain' ? ', and' : ', but'} ${ownMistake(details)}.`
  if (certainty === 'certain') return sentence
  return `${sentence} You were not sure about some of them, so the bug may be in one of them.`
}

function ownMistake(details: CallDetails): string {
  switch (details.call.outcome) {
    case 'returned':
      return 'its own result is wrong'
    case 'raised':
      return 'it raised an error itself'
    case 'unfinished':
      return 'it never finished (look for a loop that does not end)'
  }
}
