/**
 * The contract oracle (ARCHITECTURE §7.6): answers bug-finder questions from what the program
 * states about itself and what the run proved, so an interview can end without a person.
 *
 * - The run failed a postcondition of call C: C is wrong. It failed a precondition at C's entry:
 *   C is not to blame (right) and its caller broke the contract (wrong). Every call around the
 *   failure did not return, so it is wrong too.
 * - A function with a postcondition `result == EXPR` (a top-level conjunct, either side) pins its
 *   result down: each of its calls that returned is right, since the clause held. Other
 *   postconditions only ever say "wrong", through the failure above.
 * - `assert(F(args) == EXPECTED)` is an example: the call of F made inside it is right when the
 *   assertion passed and wrong when it failed (R018 there).
 *
 * A "right" answer only vouches for a result, so it is not given for a call that changed anything
 * outside itself (a person has to judge those effects). Answers spread to identical calls through
 * the finder's memo keys. Built only on the public `Recording` API.
 */
import type { Recording } from './api-types'
import type { AutoAnswer, CallOracle } from './bug-finder'
import { changeTexts } from './bug-finder-text'
import type { CallNode, CallTree } from './calls'
import type { ContractClause } from './ast'
import {
  type AssertionExample,
  type OracleSyntax,
  scanOracleSyntax,
  spanKey,
} from './oracle-syntax'
import { parse } from './parser'
import { LineIndex, type Span } from './span'

/** How far past a call the scan for its assertion's own step goes. */
const MAX_ASSERT_SCAN = 100_000

export type { AssertionExample } from './oracle-syntax'

/** Automatic answers from the contracts and assertions of `recording`'s program. */
export function contractOracle(recording: Recording, tree: CallTree): CallOracle {
  const facts = new ContractFacts(recording, tree)
  return (call) => facts.answer(call)
}

function right(reason: string, line: number | null): AutoAnswer {
  return { answer: 'right', reason, line }
}

function wrong(reason: string, line: number | null): AutoAnswer {
  return { answer: 'wrong', reason, line }
}

function sameSpan(a: Span, b: Span): boolean {
  return a.start === b.start && a.end === b.end
}

class ContractFacts {
  private readonly lines: LineIndex
  private syntaxCache: OracleSyntax | null = null
  private failures: ReadonlyMap<number, AutoAnswer> | null = null

  constructor(
    private readonly recording: Recording,
    private readonly tree: CallTree,
  ) {
    this.lines = new LineIndex(recording.program.source)
  }

  answer(call: CallNode): AutoAnswer | null {
    if (call.depth === 0) return null
    return (
      this.failureChain().get(call.id) ?? this.fromAssertion(call) ?? this.fromPostcondition(call)
    )
  }

  private get syntax(): OracleSyntax {
    this.syntaxCache ??= scanOracleSyntax(parse(this.recording.program.source).program)
    return this.syntaxCache
  }

  private lineOf(span: Span): number {
    return this.lines.lineOf(span.start)
  }

  // --- the run's failure ----------------------------------------------------------------------

  /** Answers for the calls the failure ran through, when it was a contract or an assertion. */
  private failureChain(): ReadonlyMap<number, AutoAnswer> {
    if (this.failures !== null) return this.failures
    const answers = new Map<number, AutoAnswer>()
    this.failures = answers
    const { recording, tree } = this
    const outcome = recording.outcome
    if (outcome.kind !== 'error') return answers
    const error = outcome.error
    const failing = tree.callAt(recording.length)
    const line = this.lineOf(error.span)
    if (error.code === 'R027') {
      answers.set(failing.id, wrong(`its postcondition on line ${line} failed`, line))
      this.wrongAround(
        answers,
        failing,
        `the postcondition of ${failing.name} on line ${line}`,
        line,
      )
    } else if (error.code === 'R026') {
      answers.set(
        failing.id,
        right(`its precondition on line ${line} failed: its caller is to blame`, line),
      )
      const caller = tree.parent(failing)
      if (caller !== null && caller.depth > 0) {
        answers.set(
          caller.id,
          wrong(`it broke the precondition of ${failing.name} on line ${line}`, line),
        )
        const what = `the precondition of ${failing.name} on line ${line}`
        this.wrongAround(answers, caller, what, line)
      }
    } else if (error.code === 'R018') {
      const example = this.syntax.assertions.find((a) => sameSpan(a.assertSpan, error.span))
      if (example === undefined) return answers
      const judged = this.judgedByFailedAssertion(failing, example)
      if (judged === null) return answers
      answers.set(judged.id, wrong(`the assertion on line ${line} failed`, line))
      if (failing.depth > 0) {
        answers.set(
          failing.id,
          wrong(`it did not return: the assertion on line ${line} failed`, line),
        )
      }
      this.wrongAround(answers, failing, `the assertion on line ${line}`, line)
    }
    return answers
  }

  /** Every call around `call` (not the root) did not return: wrong. */
  private wrongAround(
    answers: Map<number, AutoAnswer>,
    call: CallNode,
    what: string,
    line: number,
  ): void {
    for (let up = this.tree.parent(call); up !== null && up.depth > 0; up = this.tree.parent(up)) {
      answers.set(up.id, wrong(`it did not return: ${what} failed inside it`, line))
    }
  }

  /** The last call made at the example's site inside `frame` before the run stopped. */
  private judgedByFailedAssertion(frame: CallNode, example: AssertionExample): CallNode | null {
    const children = this.tree.children(frame)
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!
      if (child.outcome === 'returned' && this.siteOf(child, example)) return child
    }
    return null
  }

  // --- assertions -------------------------------------------------------------------------------

  private siteOf(call: CallNode, example: AssertionExample): boolean {
    const site = this.recording.locationAt(call.entry - 1)
    return (
      site !== null &&
      site.source === 'main' &&
      site.opName === 'Call' &&
      sameSpan(site.span, example.siteSpan)
    )
  }

  private fromAssertion(call: CallNode): AutoAnswer | null {
    if (call.library || call.outcome !== 'returned') return null
    const example = this.syntax.assertions.find((candidate) => this.siteOf(call, candidate))
    if (example === undefined) return null
    const line = this.lineOf(example.assertSpan)
    const verdict = this.assertionOutcome(call, example)
    if (verdict === 'failed') return wrong(`the assertion on line ${line} failed`, line)
    if (verdict === 'passed' && !this.changesSomething(call)) {
      return right(`the assertion on line ${line}`, line)
    }
    return null
  }

  /**
   * Whether the assertion around `call` passed: its native `Call` step in the caller's frame after
   * the call returned either completed (passed) or is where the run stopped with its R018.
   */
  private assertionOutcome(call: CallNode, example: AssertionExample): 'passed' | 'failed' | null {
    const { recording } = this
    const depths = recording.depthSeries()
    const length = recording.length
    const callerDepth = call.depth - 1
    const limit = Math.min(length, call.exit + MAX_ASSERT_SCAN)
    for (let t = call.exit + 1; t <= limit; t++) {
      const depth = t < length ? depths[t]! : recording.depthAt(t)
      if (depth < callerDepth) return null
      if (depth !== callerDepth) continue
      const location = recording.locationAt(t)
      if (location === null) return null
      if (location.opName !== 'Call' || !sameSpan(location.span, example.assertSpan)) continue
      if (t === length) return this.failedAt(example) ? 'failed' : null
      return recording.depthAt(t + 1) === callerDepth ? 'passed' : null
    }
    return null
  }

  private failedAt(example: AssertionExample): boolean {
    const outcome = this.recording.outcome
    return (
      outcome.kind === 'error' &&
      outcome.error.code === 'R018' &&
      sameSpan(outcome.error.span, example.assertSpan)
    )
  }

  // --- pinning postconditions -----------------------------------------------------------------

  private fromPostcondition(call: CallNode): AutoAnswer | null {
    if (call.outcome !== 'returned') return null
    const clause = this.pinningClause(call.protoId)
    if (clause === null || this.changesSomething(call)) return null
    const line = this.lineOf(clause.span)
    return right(`its postcondition on line ${line} held`, line)
  }

  private pinningClause(protoId: number): ContractClause | null {
    const { program } = this.recording
    const proto = program.protos[protoId - program.firstProtoId]
    if (proto === undefined || proto.debug.source !== 'main') return null
    return this.syntax.pinned.get(spanKey(proto.debug.span)) ?? null
  }

  private changesSomething(call: CallNode): boolean {
    return changeTexts(this.tree.details(call)).length > 0
  }
}
