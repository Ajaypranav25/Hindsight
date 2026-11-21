/** Line sets the editor marks for negative provenance and fault localization (pure). */
import {
  type GuardConstruct,
  LineIndex,
  type Recording,
  type WhyNot,
  type WhyNotOperand,
} from '../../core/index'

const idle = new WeakMap<Recording, ReadonlySet<number>>()

/**
 * The lines of the main source on which a statement starts but none ran in `recording`: the lines
 * "why didn't this run?" can be asked about (1-based).
 */
export function idleCodeLines(recording: Recording): ReadonlySet<number> {
  let lines = idle.get(recording)
  if (lines === undefined) {
    const { program } = recording
    const index = new LineIndex(program.source)
    const ran = recording.lineHitCounts()
    const found = new Set<number>()
    for (const proto of program.protos) {
      const { stmtStart, stmtSpanStart, stmtSpanEnd, source } = proto.debug
      if (source !== 'main') continue
      for (let ip = 0; ip < stmtStart.length; ip++) {
        // The program's closing instructions have an empty span at the end of the source.
        if (stmtStart[ip] !== 1 || stmtSpanEnd[ip]! <= stmtSpanStart[ip]!) continue
        const line = index.lineOf(stmtSpanStart[ip]!)
        if (!ran.has(line)) found.add(line)
      }
    }
    lines = found
    idle.set(recording, lines)
  }
  return lines
}

/** The step an explanation points at: where the decision was made, or where the run stopped. */
export function whyNotMoment(why: WhyNot): number | null {
  switch (why.kind) {
    case 'guard':
      return why.time
    case 'cut-short':
      return why.time
    case 'never-called':
      return why.callSite === null ? null : whyNotMoment(why.callSite)
    default:
      return null
  }
}

/** The line of the guard an explanation blames (also through a call site), or null. */
export function whyNotGuardLine(why: WhyNot): number | null {
  if (why.kind === 'guard') return why.guardLine
  return why.kind === 'never-called' && why.callSite !== null ? whyNotGuardLine(why.callSite) : null
}

/** The guard that kept a line from running, laid out for the inline explanation. */
export interface GuardDisplay {
  /** `if total > 80`, `while i < n`, `for … in xs`, `match shape`. */
  readonly code: string
  readonly value: string
  /** The decision step. */
  readonly time: number
  readonly checks: number
  readonly guardLine: number
  /** What the value meant, for loops and arms (", so there was nothing to loop over"). */
  readonly meaning: string
  readonly operands: readonly WhyNotOperand[]
}

/** The inline explanation of why a line did not run (ARCHITECTURE §11.3). */
export interface WhyNotDisplay {
  readonly title: string
  /** The sentence, shown when there is no guard to lay out (or before it, for an uncalled function). */
  readonly sentence: string | null
  readonly guard: GuardDisplay | null
  /** "Go to the decision" (or where the run stopped), when there is a moment to go to. */
  readonly decision: { readonly label: string; readonly time: number } | null
  /** "Go to where it was set": the first operand's write, when one was recorded. */
  readonly origin: { readonly name: string; readonly time: number } | null
}

const GUARD_KEYWORDS: Readonly<Record<GuardConstruct, (condition: string) => string>> = {
  if: (condition) => `if ${condition}`,
  else: (condition) => `if ${condition}`,
  while: (condition) => `while ${condition}`,
  for: (condition) => `for … in ${condition}`,
  match: (condition) => `match ${condition}`,
}

const GUARD_MEANINGS: Readonly<Record<GuardConstruct, string>> = {
  if: '',
  else: ', so the else branch was skipped',
  while: '',
  for: ', so there was nothing to loop over',
  match: ', which this arm did not take',
}

function guardDisplay(why: Extract<WhyNot, { kind: 'guard' }>): GuardDisplay {
  return {
    code: GUARD_KEYWORDS[why.construct](why.condition),
    value: why.value,
    time: why.time,
    checks: why.checks,
    guardLine: why.guardLine,
    meaning: GUARD_MEANINGS[why.construct],
    operands: why.operands,
  }
}

/** The guard an explanation lays out: its own, or that of an uncalled function's call site. */
function guardOf(why: WhyNot): Extract<WhyNot, { kind: 'guard' }> | null {
  if (why.kind === 'guard') return why
  return why.kind === 'never-called' && why.callSite !== null ? guardOf(why.callSite) : null
}

export function whyNotDisplay(why: WhyNot): WhyNotDisplay {
  const guard = guardOf(why)
  const moment = whyNotMoment(why)
  const operand = guard?.operands.find((candidate) => candidate.origin !== null) ?? null
  return {
    title: `Why line ${why.line} did not run`,
    sentence: why.kind === 'guard' ? null : neverCalledLead(why),
    guard: guard === null ? null : guardDisplay(guard),
    decision:
      moment === null
        ? null
        : {
            label: why.kind === 'cut-short' ? 'Go to where the run stopped' : 'Go to the decision',
            time: moment,
          },
    origin:
      operand === null || operand.origin === null
        ? null
        : { name: operand.name, time: operand.origin.time },
  }
}

/** For an uncalled function whose call site is laid out, only the lead of its sentence. */
function neverCalledLead(why: WhyNot): string {
  if (why.kind !== 'never-called' || guardOf(why) === null) return why.sentence
  const cut = why.sentence.indexOf('did not run.')
  return cut < 0 ? why.sentence : why.sentence.slice(0, cut + 'did not run.'.length)
}
