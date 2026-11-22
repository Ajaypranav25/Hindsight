/**
 * The `suggest_repairs` tool (ARCHITECTURE §7.12, §9.1): verified one-token patches. In `crash`
 * mode a patch must make the run finish. In `examples` mode the agent states what some calls
 * should return (`{"call": "average([92, 88, 95])", "expected": "91.66666666666667"}`); the
 * expectations are matched against the recorded calls by their rendered arguments, judged right
 * or wrong, and a patch must keep the right ones and change the wrong ones. Arguments and expected
 * values are put in canonical form by the language itself (`repr`), so `[92,88,95]` matches.
 */
import {
  type CallDetails,
  type CallNode,
  type CallTree,
  callTree,
  compile,
  parse,
  type Recording,
  type RepairExample,
  repairExample,
  type RepairResult,
  run,
} from '../core/index'
import { deepText } from '../core/call-values'
import { searchRepairs } from './lab'
import {
  type Args,
  choiceArg,
  integerArg,
  type Json,
  jsonLiteral,
  type JsonObject,
  MAX_STEPS,
  schema,
  SEED,
  SOURCE,
  stringArg,
  type Tool,
  type ToolContext,
  ToolError,
  TRACE_ID,
} from './mcp-shared'

/** The most calls of a function compared with the expectations. */
const MAX_CALLS_SCANNED = 5_000
const MAX_EXPECTATIONS = 50
const TEXT_LIMIT = 4096
const CANONICAL_STEPS = 100_000

export const MUTANTS = {
  type: 'integer',
  minimum: 1,
  maximum: 400,
  description:
    'One-token changes to try at most (default 150, fewer on long runs: all mutants together run at most 40,000,000 steps); each runs the whole program',
} as const

/** Steps all repair mutants of one tool call may run together; caps the mutant count on long runs. */
export const REPAIR_STEP_BUDGET = 40_000_000
/** A repair mutant runs at most this many steps (four times the run, as `repairSearch` does). */
const mutantSteps = (steps: number) => Math.max(steps * 4, steps + 50_000)

/** `max_mutants` and `max_repairs`, the mutants capped so they fit `REPAIR_STEP_BUDGET`. */
export function repairBudget(
  args: Args,
  recording: Recording,
  defaults: { readonly mutants: number; readonly repairs: number } = { mutants: 150, repairs: 5 },
): { readonly maxMutants: number; readonly maxRepairs: number } {
  const affordable = Math.max(10, Math.floor(REPAIR_STEP_BUDGET / mutantSteps(recording.length)))
  return {
    maxMutants: Math.min(integerArg(args, 'max_mutants', defaults.mutants, 1, 400), affordable),
    maxRepairs: integerArg(args, 'max_repairs', defaults.repairs, 1, 10),
  }
}
export const REPAIRS = {
  type: 'integer',
  minimum: 1,
  maximum: 10,
  description: 'Stop after this many verified repairs (default 5)',
} as const

/** The schema of expectations: what some calls should return. */
export const EXPECTATIONS = {
  type: 'array',
  description: 'For mode "examples": what calls should return',
  items: {
    type: 'object',
    properties: {
      call: { type: 'string', description: 'A call as source text: average([92, 88, 95])' },
      function: { type: 'string' },
      args: { type: 'array', description: 'Argument literals, as text or JSON values' },
      expected: {
        description: 'The value it should return: a literal as text, or a JSON value',
      },
      returns: { description: 'Same as expected' },
    },
  },
} as const

/** Verified repairs as JSON: what changed, the line before and after, what the calls do now. */
export function repairsJson(result: RepairResult): JsonObject {
  return {
    candidates: result.repairs.map((repair) => ({
      line: repair.line,
      change: repair.change,
      before: repair.before.trim(),
      after: repair.after.trim(),
      now: [...repair.now],
    })),
    mutants_checked: result.tried,
    budget_exhausted: result.exhausted,
    problem: result.problem,
  }
}

export function suggestRepairsTool(context: ToolContext): Tool {
  return {
    name: 'suggest_repairs',
    description:
      'Verified one-token patches (an operator, comparison, number or boolean changed), each checked by re-running the whole program. mode "crash": patches that make a crashed run finish. mode "examples": give expectations such as [{"call": "average([92, 88, 95])", "expected": "91.66666666666667"}] or [{"function": "average", "args": ["[92, 88, 95]"], "returns": "91.66666666666667"}]; they are matched against the recorded calls, judged right or wrong, and a patch must keep the right calls and change the wrong ones. Returns each patch with the source line before and after and what the formerly wrong calls return now; check that this is what you meant.',
    inputSchema: schema(
      {
        trace_id: TRACE_ID,
        source: SOURCE,
        max_steps: MAX_STEPS,
        seed: SEED,
        mode: {
          type: 'string',
          enum: ['crash', 'examples'],
          description: 'Default: examples when expectations are given, else crash',
        },
        expectations: EXPECTATIONS,
        function: {
          type: 'string',
          description: 'The function to repair when expectations judge several wrong',
        },
        max_mutants: MUTANTS,
        max_repairs: REPAIRS,
      },
      [],
    ),
    run: (args) => suggestRepairs(context, args),
  }
}

function suggestRepairs(context: ToolContext, args: Args): Json {
  const trace = context.traceOrSource(args, 'trace_id', 'source')
  const options = repairBudget(args, trace.recording)
  const given = args.expectations
  const mode = choiceArg(
    args,
    'mode',
    ['crash', 'examples'] as const,
    given === undefined ? 'crash' : 'examples',
  )
  const { recording } = trace
  if (mode === 'crash') {
    const result = searchRepairs(recording, { kind: 'crash' }, options)
    if (result.problem !== null) {
      const hint =
        recording.outcome.kind === 'error'
          ? ''
          : ' Use mode "examples" with expectations for a wrong result.'
      throw new ToolError(`${result.problem}${hint}`)
    }
    return { trace_id: trace.id, mode, ...flatRepairs(result) }
  }
  const expectations = parseExpectations(given)
  const tree = callTree(recording)
  const judged = expectations.map((expectation) => judge(tree, expectation))
  const examples = new Map<string, { readonly example: RepairExample; readonly call: CallNode }>()
  for (const verdict of judged) {
    for (const match of verdict.matches) {
      const example = repairExample(match.details, verdict.right(match) ? 'right' : 'wrong')
      examples.set([example.name, ...example.args].join('\u0000'), {
        example,
        call: match.details.call,
      })
    }
  }
  const base = {
    trace_id: trace.id,
    mode,
    judged: judged.flatMap((verdict) => verdict.json),
    unmatched: judged.flatMap((verdict) => verdict.unmatched),
  }
  const wrong = [...examples.values()].filter((entry) => entry.example.answer === 'wrong')
  if (wrong.length === 0) {
    return {
      ...base,
      repairs: [],
      note: 'No matched call is wrong: nothing to repair. Check the unmatched expectations.',
    }
  }
  const call = target(
    wrong.map((entry) => entry.call),
    stringArg(args, 'function'),
  )
  const result = searchRepairs(
    recording,
    {
      kind: 'examples',
      protoId: call.protoId,
      examples: [...examples.values()].map((entry) => entry.example),
    },
    options,
  )
  if (result.problem !== null) throw new ToolError(result.problem)
  return { ...base, function: call.name, ...flatRepairs(result) }
}

function flatRepairs(result: RepairResult): JsonObject {
  const json = repairsJson(result)
  const found = (json.candidates as Json[]).length
  return {
    repairs: json.candidates!,
    mutants_checked: json.mutants_checked!,
    budget_exhausted: json.budget_exhausted!,
    note:
      found > 0
        ? 'Each patch was verified by re-running the program. Prefer the one whose "now" matches your intent, then check the whole patched program with verify_patch (or diff_runs).'
        : result.exhausted
          ? 'No one-token change worked within the budget: raise max_mutants, or write a larger fix and check it with verify_patch.'
          : 'No one-token change works: write a larger fix and check it with verify_patch (same expectations).',
  }
}

/** The one function to repair: the only one with wrong calls, or the one named. */
function target(calls: readonly CallNode[], named: string | null): CallNode {
  const names = [...new Set(calls.map((call) => call.name))]
  const chosen = named ?? (names.length === 1 ? names[0]! : null)
  if (chosen === null) {
    throw new ToolError(
      `Expectations judge calls of several functions wrong (${names.join(', ')}): give function to choose the one to repair`,
    )
  }
  const call = calls.find((candidate) => candidate.name === chosen)
  if (call === undefined) {
    throw new ToolError(`No call of ${chosen} was judged wrong (wrong: ${names.join(', ')})`)
  }
  return call
}

// --- expectations -------------------------------------------------------------------------------

export interface Expectation {
  readonly index: number
  readonly text: string
  readonly function: string
  /** Canonical argument texts. */
  readonly args: readonly string[]
  readonly expected: string
  readonly canonical: string | null
}

/** Literal text as given, or a JSON value (number, list, record, …) written as a literal. */
function literalText(value: unknown, what: string): string {
  return typeof value === 'string' ? value.trim() : jsonLiteral(value, what)
}

/** The canonical (`repr`) text of a literal expression, or null when it is not one. */
export function canonical(text: string): string | null {
  const parsed = parse(`(${text})`)
  const [statement, extra] = parsed.program.body
  if (parsed.diagnostics.length > 0 || statement?.kind !== 'ExprStmt' || extra !== undefined)
    return null
  const compiled = compile(`print(repr(${text}))\n`)
  if (!compiled.ok) return null
  const result = run(compiled.program, { maxSteps: CANONICAL_STEPS })
  return result.outcome.kind === 'finished' && result.outputs.length === 1
    ? result.outputs[0]!.text
    : null
}

function callParts(text: string): { readonly name: string; readonly args: string[] } | null {
  const parsed = parse(text)
  const [statement, extra] = parsed.program.body
  if (parsed.diagnostics.length > 0 || statement?.kind !== 'ExprStmt' || extra !== undefined)
    return null
  const call = statement.expr
  if (call.kind !== 'Call' || call.pipe || call.callee.kind !== 'Ident') return null
  return {
    name: call.callee.name,
    args: call.args.map((arg) => text.slice(arg.span.start, arg.span.end)),
  }
}

export function parseExpectations(given: unknown): Expectation[] {
  if (!Array.isArray(given) || given.length === 0) {
    throw new ToolError(
      'expectations must be a non-empty array of {call, expected} or {function, args, returns}',
    )
  }
  if (given.length > MAX_EXPECTATIONS)
    throw new ToolError(`at most ${MAX_EXPECTATIONS} expectations`)
  return given.map((item: unknown, index): Expectation => {
    if (item === null || typeof item !== 'object')
      throw new ToolError(`expectation ${index + 1} must be an object`)
    const entry = item as Record<string, unknown>
    const value = entry.expected !== undefined ? entry.expected : entry.returns
    if (value === undefined)
      throw new ToolError(`expectation ${index + 1} needs expected (or returns)`)
    const expected = literalText(value, `expectation ${index + 1}'s expected value`)
    let name: string
    let args: string[]
    if (typeof entry.call === 'string') {
      const parts = callParts(entry.call)
      if (parts === null)
        throw new ToolError(
          `expectation ${index + 1}: call must look like name(arg, …), got ${JSON.stringify(entry.call)}`,
        )
      name = parts.name
      args = parts.args
    } else if (typeof entry.function === 'string' && Array.isArray(entry.args)) {
      name = entry.function
      args = entry.args.map((arg: unknown, i) =>
        literalText(arg, `expectation ${index + 1}'s argument ${i + 1}`),
      )
    } else {
      throw new ToolError(`expectation ${index + 1} needs call, or function and args`)
    }
    return {
      index: index + 1,
      text: `${name}(${args.join(', ')})`,
      function: name,
      args: args.map((arg) => canonical(arg) ?? arg),
      expected,
      canonical: canonical(expected),
    }
  })
}

interface Match {
  readonly details: CallDetails
  readonly recorded: string
}

/** How a run fares against each expectation: the recorded result and right, wrong or unmatched. */
export function checkExpectations(
  recording: Recording,
  expectations: readonly Expectation[],
): JsonObject[] {
  const tree = callTree(recording)
  return expectations.map((expectation) => {
    const verdict = judge(tree, expectation)
    const first = verdict.matches[0]
    return {
      call: expectation.text,
      expected: expectation.canonical ?? expectation.expected,
      recorded: first?.recorded ?? null,
      verdict: first === undefined ? 'unmatched' : verdict.right(first) ? 'right' : 'wrong',
    }
  })
}

interface Judged {
  readonly matches: readonly Match[]
  readonly right: (match: Match) => boolean
  readonly json: Json[]
  readonly unmatched: Json[]
}

function fullText(
  recording: Recording,
  time: number,
  details: CallDetails,
  value: CallDetails['args'][number]['value'],
): string {
  return deepText(recording, time, value, 'display', TEXT_LIMIT)?.text ?? details.call.name
}

function recordedText(recording: Recording, details: CallDetails): string {
  const { call } = details
  if (call.outcome === 'raised')
    return `raised ${details.error?.code ?? 'an error'}: ${details.error?.message ?? ''}`
  if (call.outcome === 'unfinished' || details.result === null) return 'did not finish'
  return fullText(recording, call.exit + 1, details, details.result.value)
}

function argumentTexts(recording: Recording, details: CallDetails): string[] {
  return details.args.map((arg) => fullText(recording, details.call.entry, details, arg.value))
}

function sameArguments(expectation: Expectation, args: readonly string[]): boolean {
  return (
    args.length === expectation.args.length && args.every((text, i) => text === expectation.args[i])
  )
}

/** A call the expectation matches did what it expected: returned the expected value. */
function isRight(expectation: Expectation, details: CallDetails, recorded: string): boolean {
  if (details.call.outcome !== 'returned') return false
  if (expectation.canonical !== null && recorded === expectation.canonical) return true
  const value = details.result?.value
  return (
    recorded === expectation.expected ||
    (value?.kind === 'string' && value.value === expectation.expected)
  )
}

/**
 * Answers bug finder questions from expectations: a call of an expected function with the
 * expected arguments is right when it returned the expected value and wrong otherwise; any other
 * call is left to the agent (null).
 */
export function expectationOracle(
  recording: Recording,
  expectations: readonly Expectation[],
): (details: CallDetails) => 'right' | 'wrong' | null {
  return (details) => {
    const named = expectations.filter((expectation) => expectation.function === details.call.name)
    if (named.length === 0 || details.call.depth === 0) return null
    const args = argumentTexts(recording, details)
    const expectation = named.find((candidate) => sameArguments(candidate, args))
    if (expectation === undefined) return null
    return isRight(expectation, details, recordedText(recording, details)) ? 'right' : 'wrong'
  }
}

function judge(tree: CallTree, expectation: Expectation): Judged {
  const { recording } = tree
  const matches: Match[] = []
  const seen: string[] = []
  let scanned = 0
  for (const call of tree.calls({ justMyCode: true })) {
    if (call.depth === 0 || call.name !== expectation.function) continue
    if (scanned++ >= MAX_CALLS_SCANNED) break
    const details = tree.details(call)
    const args = argumentTexts(recording, details)
    if (seen.length < 5) seen.push(`${call.name}(${args.join(', ')})`)
    if (!sameArguments(expectation, args)) continue
    matches.push({ details, recorded: recordedText(recording, details) })
  }
  const right = (match: Match): boolean => isRight(expectation, match.details, match.recorded)
  if (matches.length === 0) {
    const reason =
      scanned === 0
        ? `no call of ${expectation.function} was recorded`
        : `no call of ${expectation.function} had these arguments`
    return {
      matches,
      right,
      json: [],
      unmatched: [
        { expectation: expectation.index, call: expectation.text, reason, recorded_calls: seen },
      ],
    }
  }
  const first = matches[0]!
  return {
    matches,
    right,
    json: [
      {
        expectation: expectation.index,
        call: expectation.text,
        calls_matched: matches.length,
        first_step: first.details.call.entry,
        recorded: first.recorded,
        expected: expectation.canonical ?? expectation.expected,
        verdict: right(first) ? 'right' : 'wrong',
      },
    ],
    unmatched: [],
  }
}
