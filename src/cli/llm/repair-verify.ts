/**
 * Checking a model's rewrite of one function (ARCHITECTURE §9.2). The candidate must be one
 * function of the same name; it is spliced into the program over the function's span, compiled
 * and recorded under a step limit (four times the original run, as for repair previews), and the
 * run is held to the evidence:
 *
 * - crash: the run finishes;
 * - examples: every call judged right still returns the same value, every call judged wrong is
 *   made again and returns something else (the expected value, when one is known), and no
 *   contract or assertion fails (nor any new runtime error).
 *
 * A verified candidate's behavior change is summarized with `diffRuns` against the original.
 */
import {
  type CallDetails,
  type CallNode,
  callTree,
  compile,
  crashCulprit,
  diffRuns,
  LineIndex,
  type LineSpan,
  parse,
  record,
  type Recording,
  type Span,
} from '../../core/index'
import { originReason } from '../diff'
import { failureOf } from '../mcp-verify'
import { callWithArguments, resultText, valueText } from './context'
import { compareValues, evaluatePrediction, type ValueAt } from './values'

/** A call the interview judged, and who judged it. */
export interface RepairJudgment {
  readonly call: CallNode
  readonly answer: 'right' | 'wrong'
  /** What a call judged wrong should return, when known (the model's confident prediction). */
  readonly expected: string | null
  /** "you", or the evidence of an automatic answer. */
  readonly by: string
}

export type RepairGoal =
  | { readonly kind: 'crash' }
  | {
      readonly kind: 'examples'
      readonly protoId: number
      readonly judgments: readonly RepairJudgment[]
    }

/** The function to rewrite. */
export interface RepairTarget {
  readonly protoId: number
  readonly name: string
  readonly span: Span
  /** Its source text (the span). */
  readonly text: string
  /** Written `fn NAME(…) {…}` (a declaration) rather than as a function value. */
  readonly declared: boolean
  readonly lines: LineSpan
}

/** The most calls of the judged functions scanned in a candidate's run. */
const MAX_CALLS_SCANNED = 5_000
const MIN_EXTRA_STEPS = 50_000

/** The function a goal rewrites, or why there is none. */
export function repairTarget(recording: Recording, goal: RepairGoal): RepairTarget | string {
  const { program } = recording
  let protoId: number
  if (goal.kind === 'crash') {
    if (recording.outcome.kind !== 'error') return 'The run did not crash.'
    // A failed precondition blames the caller (SPEC §7.16).
    const frame = crashCulprit(recording)
    if (frame === null) return 'The crash is not in code of the program itself.'
    protoId = frame.protoId
  } else {
    protoId = goal.protoId
  }
  if (protoId === program.script.id)
    return 'The fault is in the top-level code, not in a function: AI repair rewrites one function.'
  const proto = program.protos[protoId - program.firstProtoId]
  if (proto === undefined || proto.debug.source !== 'main')
    return 'That function is not in the program.'
  const { span } = proto.debug
  const text = program.source.slice(span.start, span.end)
  const name = proto.name ?? 'the function'
  const index = new LineIndex(program.source)
  return {
    protoId,
    name,
    span,
    text,
    declared: proto.name !== null && new RegExp(`^fn\\s+${proto.name}\\s*\\(`).test(text),
    lines: {
      start: index.lineOf(span.start),
      end: index.lineOf(Math.max(span.start, span.end - 1)),
    },
  }
}

/** Why `text` cannot replace the target, or null when it is one function of the right form. */
export function shapeProblem(target: RepairTarget, text: string): string | null {
  if (target.declared) {
    const parsed = parse(text)
    const first = parsed.diagnostics[0]
    if (first !== undefined) {
      const line = new LineIndex(text).lineOf(first.span.start)
      return `it does not parse: ${first.message} (its line ${line})`
    }
    const [statement, extra] = parsed.program.body
    if (statement?.kind !== 'FnDecl' || extra !== undefined)
      return `it is not one function declaration (fn ${target.name}(…) { … })`
    if (statement.name !== target.name) return `it renames ${target.name} to ${statement.name}`
    return null
  }
  const parsed = parse(`(${text})`)
  const [statement, extra] = parsed.program.body
  if (
    parsed.diagnostics.length > 0 ||
    statement?.kind !== 'ExprStmt' ||
    statement.expr.kind !== 'Function' ||
    extra !== undefined
  ) {
    return 'it is not one function'
  }
  return null
}

/** The program with the target's text replaced by `text`. */
export function splice(source: string, target: RepairTarget, text: string): string {
  return source.slice(0, target.span.start) + text + source.slice(target.span.end)
}

// --- examples -------------------------------------------------------------------------------------

/** A judged call, prepared for checking candidates: how to find it again and what it must do. */
export interface Example {
  readonly key: string
  readonly name: string
  /** The call with its arguments, as shown to the model and in reasons. */
  readonly shown: string
  readonly answer: 'right' | 'wrong'
  readonly by: string
  /** Its result in the original run (null when it did not return). */
  readonly before: ValueAt | null
  readonly beforeText: string
  /** The value it should return (for a call judged wrong), when known. */
  readonly expected: ValueAt | null
  readonly expectedText: string | null
}

/** Identifies a call across runs: its function and its argument values as text. */
function keyOf(recording: Recording, details: CallDetails): string {
  const { call } = details
  return [
    call.name,
    ...details.args.map((arg) => valueText(recording, call.entry, arg.value)),
  ].join('\u0000')
}

function resultAt(recording: Recording, call: CallNode, details: CallDetails): ValueAt | null {
  if (call.outcome !== 'returned' || details.result === null) return null
  return { recording, time: call.exit + 1, value: details.result.value }
}

/** The judged calls of the original run, ready to check candidates against. */
export function prepareExamples(
  recording: Recording,
  judgments: readonly RepairJudgment[],
): Example[] {
  const tree = callTree(recording)
  const examples: Example[] = []
  const seen = new Set<string>()
  for (const judgment of judgments) {
    const details = tree.details(judgment.call)
    const key = keyOf(recording, details)
    if (judgment.call.depth === 0 || seen.has(key)) continue
    seen.add(key)
    const predicted = judgment.expected === null ? null : evaluatePrediction(judgment.expected)
    const expected = predicted?.ok === true ? predicted : null
    examples.push({
      key,
      name: judgment.call.name,
      shown: callWithArguments(recording, details),
      answer: judgment.answer,
      by: judgment.by,
      before: resultAt(recording, judgment.call, details),
      beforeText: resultText(recording, details) ?? outcomeWord(judgment.call),
      expected: expected?.at ?? null,
      expectedText: expected?.text ?? null,
    })
  }
  return examples
}

function outcomeWord(call: CallNode): string {
  return call.outcome === 'raised' ? 'raised an error' : 'did not finish'
}

function sameValue(a: ValueAt, b: ValueAt): boolean {
  const comparison = compareValues(a, b)
  if (comparison !== 'unknown') return comparison === 'equal'
  return valueText(a.recording, a.time, a.value) === valueText(b.recording, b.time, b.value)
}

function judgedBy(example: Example): string {
  return example.by === 'you'
    ? `you judged it ${example.answer}`
    : `judged ${example.answer}: ${example.by}`
}

interface ExampleCheck {
  readonly reasons: string[]
  readonly now: string[]
}

/** Holds a candidate's run to the examples: what failed, and what the wrong calls do now. */
export function checkExamples(patched: Recording, examples: readonly Example[]): ExampleCheck {
  const tree = callTree(patched)
  const wanted = new Set(examples.map((example) => example.key))
  const names = new Set(examples.map((example) => example.name))
  const found = new Map<string, CallNode>()
  let scanned = 0
  for (const call of tree.calls({ justMyCode: true })) {
    if (call.depth === 0 || !names.has(call.name)) continue
    if (scanned++ >= MAX_CALLS_SCANNED || found.size === wanted.size) break
    const key = keyOf(patched, tree.details(call))
    if (wanted.has(key) && !found.has(key)) found.set(key, call)
  }
  const reasons: string[] = []
  const now: string[] = []
  for (const example of examples) {
    const call = found.get(example.key)
    if (call === undefined) {
      if (example.answer === 'wrong') reasons.push(`${example.shown} is no longer called`)
      continue
    }
    const details = tree.details(call)
    const after = resultAt(patched, call, details)
    const afterText = resultText(patched, details) ?? outcomeWord(call)
    if (example.answer === 'right') {
      if (after === null || example.before === null || !sameValue(example.before, after))
        reasons.push(
          `${example.shown} returned ${example.beforeText} (${judgedBy(example)}); now ${afterText}`,
        )
      continue
    }
    if (after === null) {
      reasons.push(`${example.shown} now ${afterText}`)
    } else if (example.expected !== null) {
      if (sameValue(after, example.expected))
        now.push(`${example.shown} now returns ${afterText}, as expected`)
      else
        reasons.push(
          `${example.shown} should return ${example.expectedText}; it now returns ${afterText}`,
        )
    } else if (example.before !== null && sameValue(after, example.before)) {
      reasons.push(`${example.shown} still returns ${example.beforeText} (${judgedBy(example)})`)
    } else {
      now.push(`${example.shown} now returns ${afterText}`)
    }
  }
  return { reasons, now }
}

// --- candidates -----------------------------------------------------------------------------------

export interface VerifyContext {
  readonly recording: Recording
  readonly target: RepairTarget
  readonly goal: RepairGoal
  /** The judged calls (examples goal; empty for a crash). */
  readonly examples: readonly Example[]
  readonly seed: number
}

export type CandidateCheck =
  | {
      readonly verified: true
      readonly source: string
      /** What the judged-wrong calls do now, and how the run's behavior changed. */
      readonly notes: readonly string[]
    }
  | {
      readonly verified: false
      readonly source: string | null
      readonly reasons: readonly string[]
    }

function compileProblem(source: string): string | null {
  const compiled = compile(source)
  if (compiled.ok) return null
  const first = compiled.diagnostics[0]!
  const line = new LineIndex(source).lineOf(first.span.start)
  return `the program does not compile with it: ${first.code} ${first.message} (line ${line})`
}

/** Splices, compiles, records and checks one candidate. */
export function verifyCandidate(context: VerifyContext, given: string): CandidateCheck {
  const text = given.trim()
  const shape = shapeProblem(context.target, text)
  if (shape !== null) return { verified: false, source: null, reasons: [shape] }
  const { recording } = context
  const source = splice(recording.program.source, context.target, text)
  const problem = compileProblem(source)
  if (problem !== null) return { verified: false, source, reasons: [problem] }
  const compiled = compile(source)
  if (!compiled.ok)
    return { verified: false, source, reasons: ['the program does not compile with it'] }
  const maxSteps = Math.max(recording.length * 4, recording.length + MIN_EXTRA_STEPS)
  const patched = record(compiled.program, { maxSteps, seed: context.seed })
  const reasons = runProblems(context, patched)
  const examples =
    context.goal.kind === 'examples' ? checkExamples(patched, context.examples) : null
  reasons.push(...(examples?.reasons ?? []))
  if (reasons.length > 0) return { verified: false, source, reasons }
  return {
    verified: true,
    source,
    notes: [...(examples?.now ?? []), ...behaviorLines(recording, patched)],
  }
}

/** How the candidate's run fails where it must not. */
function runProblems(context: VerifyContext, patched: Recording): string[] {
  const before = failureOf(context.recording)
  const after = failureOf(patched)
  if (after === null) return []
  if (context.goal.kind === 'crash') {
    return [
      before !== null && before.key === after.key
        ? `the run still ${after.text}`
        : `the run now ${after.text}`,
    ]
  }
  if (after.check || before === null || before.key !== after.key)
    return [`the run now ${after.text}`]
  return []
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The behavior change against the original, in a few lines (`diffRuns`). */
export function behaviorLines(original: Recording, patched: Recording): string[] {
  const diff = diffRuns(original, patched, { limit: 3 })
  if (diff.same) return ['it behaves exactly as before on this run']
  const lines: string[] = []
  if (!diff.sameOutcome) {
    const failure = failureOf(patched)
    lines.push(failure === null ? 'the run finishes' : `the run ${failure.text}`)
  }
  const changed = diff.output.lines.filter((line) => line.kind !== 'same')
  if (changed.length > 0) {
    const shown = changed
      .slice(0, 3)
      .map((line) => `${line.kind === 'removed' ? '-' : '+'}${line.text}`)
    const more = changed.length > 3 ? ` …` : ''
    lines.push(`output: ${shown.join('  ')}${more}`)
  }
  const origin = diff.origins.items[0]
  if (origin !== undefined) {
    const name = origin.a.depth === 0 ? 'the top-level code' : origin.a.name
    lines.push(`the difference starts in ${name}: ${originReason(origin)}`)
  }
  if (diff.changed.total > 0) lines.push(`${plural(diff.changed.total, 'call')} changed`)
  return lines
}
