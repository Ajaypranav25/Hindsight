/**
 * Contract inference (ARCHITECTURE §7.16): likely `requires`/`ensures` clauses for the functions of
 * a recorded run, in the manner of Daikon (Ernst et al., 2001). For every `fn` with at least
 * `minInputs` returned calls with different arguments, clause templates are instantiated over its
 * parameters and result (`infer-templates.ts`); a clause is kept when it held in every observed
 * call and enough different inputs exercised it, then clauses implied by others are dropped and the
 * rest ranked by support. Finally every suggestion is checked for real: the clauses are written
 * into the source, which is compiled and recorded again, and a clause that fails to compile or
 * fails on that run is withdrawn, so what is suggested holds on the whole recorded run.
 *
 * The suggestions are what the program did, not what it should do: inferred on a version you
 * trust and added to the program, they are the answers the bug finder's contract oracle (§7.6)
 * reads on a later, broken version (`result == …` clauses pin results down).
 */
import type { CompileResult, RecordOptions, Recording } from './api-types'
import type * as ast from './ast'
import type { FunctionProto, Program } from './bytecode'
import { callSignature, outcomeText } from './bug-finder-text'
import type { CallNode, CallTree } from './calls'
import { type ClauseText, fnFunctions, insertContracts, type PlacedClause } from './infer-insert'
import {
  type Candidate,
  candidatesFor,
  type Observation,
  type Param,
  TEMPLATE_PRIORITY,
  type TemplateKind,
} from './infer-templates'
import { plainKey, plainValue } from './infer-values'
import { parse } from './parser'
import { LineIndex } from './span'

export type { ClauseText, ContractAddition, InsertedContracts } from './infer-insert'
export { insertContracts } from './infer-insert'
export type { TemplateKind } from './infer-templates'

export const DEFAULT_MIN_INPUTS = 3
const DEFAULT_MAX_CALLS = 200
const DEFAULT_PER_FUNCTION = 6
/** Pinning clauses kept per function: one or two say all there is to say about the result. */
const MAX_PINS = 2
/** Verification runs (each withdraws one failing clause). */
const MAX_ROUNDS = 24
const MIN_CHECK_STEPS = 1_000_000
const MAX_CHECK_STEPS = 50_000_000
const CHECK_FACTOR_ENDED = 20
const CHECK_FACTOR_CUT = 2
/** Snapshots kept by a check's recording: it is only read for its outcome and output. */
const CHECK_SNAPSHOTS = 16

export interface InferOptions {
  /** Only the function with this name. */
  readonly fn?: string
  /** Different argument tuples a function (and a clause) needs. Default 3. */
  readonly minInputs?: number
  /** Calls read per function (evenly spaced when there are more). Default 200. */
  readonly maxCalls?: number
  /** Suggestions per function. Default 6. */
  readonly maxPerFunction?: number
  /** Check the suggestions by recording the program with them. Default true. */
  readonly verify?: boolean
  /** The seed the run was recorded with (for the check). Default 42. */
  readonly seed?: number
  /** Step limit of the check. Default: generous, from the run's length. */
  readonly maxSteps?: number
}

export interface ContractSuggestion {
  readonly kind: 'requires' | 'ensures'
  /** The clause expression: `len(result) == len(xs)`. */
  readonly clause: string
  readonly template: TemplateKind
  /** `result == EXPR`: the contract oracle answers every call that satisfies it. */
  readonly pins: boolean
  /** Calls that bore on the clause, and the different inputs among them. */
  readonly support: { readonly calls: number; readonly inputs: number }
  /** A call it held in: `average(xs = [1, 2]) returned 1.5`, with its entry step. */
  readonly example: { readonly text: string; readonly entry: number }
}

export interface FunctionContracts {
  readonly name: string
  readonly protoId: number
  /** The `fn`'s start offset (for `insertContracts`) and its line. */
  readonly functionStart: number
  readonly line: number
  /** Returned calls in the run, and how many were read. */
  readonly calls: number
  readonly sampled: number
  /** Different argument tuples among the calls read. */
  readonly inputs: number
  /** The clauses it already has, as written. */
  readonly existing: readonly string[]
  /** Best first. */
  readonly suggestions: readonly ContractSuggestion[]
  /** Why there are none, when there are none. */
  readonly note: string | null
}

export interface InferResult {
  readonly functions: readonly FunctionContracts[]
  /** True when the suggestions were checked by a run with them. */
  readonly verified: boolean
  /** Clauses withdrawn because they failed to compile or failed on the run. */
  readonly withdrawn: number
  readonly problem: string | null
}

/** What inference needs from the pipeline (index.ts supplies `compile` and `record`). */
export interface InferTools {
  compile(source: string): CompileResult
  record(program: Program, options: RecordOptions): Recording
}

interface Target {
  readonly proto: FunctionProto
  readonly fn: ast.FunctionExpr
  readonly calls: CallNode[]
}

/** Likely contracts for the functions of `tree`'s recording (see the module comment). */
export function inferContractsWith(
  tools: InferTools,
  tree: CallTree,
  options: InferOptions = {},
): InferResult {
  const recording = tree.recording
  const { program } = recording
  const parsed = parse(program.source)
  const lineIndex = new LineIndex(program.source)
  const targets = targetsOf(tree, fnFunctions(parsed.program), options.fn ?? null)
  const functions = targets.map((target) => inferFunction(tree, target, lineIndex, options))
  if (options.verify === false || functions.every((f) => f.suggestions.length === 0)) {
    return { functions, verified: options.verify !== false, withdrawn: 0, problem: null }
  }
  return verify(tools, recording, functions, options)
}

/** The `fn` functions of the program with their returned user calls, in source order. */
function targetsOf(
  tree: CallTree,
  functions: ReadonlyMap<number, ast.FunctionExpr>,
  only: string | null,
): Target[] {
  const { program } = tree.recording
  const byProto = new Map<number, Target>()
  for (const proto of program.protos) {
    if (proto.debug.source !== 'main' || proto.kind === 'script') continue
    const fn = functions.get(proto.debug.span.start)
    if (fn === undefined || (only !== null && proto.name !== only)) continue
    byProto.set(proto.id, { proto, fn, calls: [] })
  }
  for (const call of tree.calls({ justMyCode: true })) {
    if (call.outcome === 'returned' && call.depth > 0) byProto.get(call.protoId)?.calls.push(call)
  }
  return [...byProto.values()].sort((a, b) => a.fn.span.start - b.fn.span.start)
}

function inferFunction(
  tree: CallTree,
  target: Target,
  lineIndex: LineIndex,
  options: InferOptions,
): FunctionContracts {
  const minInputs = Math.max(1, options.minInputs ?? DEFAULT_MIN_INPUTS)
  const sample = evenly(target.calls, options.maxCalls ?? DEFAULT_MAX_CALLS)
  const params = paramsOf(target.fn)
  const observations = sample.map((call) => observe(tree, call))
  const keys = observations.map((o) => o.key)
  const inputs = new Set(keys).size
  const existing = target.fn.contracts.map((clause) =>
    tree.recording.program.source.slice(clause.expr.span.start, clause.expr.span.end),
  )
  const base = {
    name: target.proto.name ?? 'lambda',
    protoId: target.proto.id,
    functionStart: target.fn.span.start,
    line: lineIndex.lineOf(target.fn.span.start),
    calls: target.calls.length,
    sampled: sample.length,
    inputs,
    existing,
  }
  if (inputs < minInputs) {
    const note =
      target.calls.length === 0
        ? 'never returned in this run'
        : `returned with ${inputs} different ${inputs === 1 ? 'input' : 'inputs'}; at least ${minInputs} are needed`
    return { ...base, suggestions: [], note }
  }
  const known = new Set(existing.map(normalized))
  const kept = candidatesFor(params, observations)
    .filter((c) => !known.has(normalized(c.clause)))
    .flatMap((c) => supported(c, observations, keys, minInputs))
  const suggestions = rank(prune(kept))
    .slice(0, options.maxPerFunction ?? DEFAULT_PER_FUNCTION)
    .map((s) => s.suggestion)
  return {
    ...base,
    suggestions,
    note: suggestions.length === 0 ? 'no clause held in every call it was checked on' : null,
  }
}

/** At most `limit` items spread evenly over `items` (all of them when there are few). */
function evenly<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items]
  const step = items.length / limit
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]!)
}

/** Identifier parameters a clause can name (`result` is the result in `ensures`). */
function paramsOf(fn: ast.FunctionExpr): Param[] {
  const params: Param[] = []
  fn.params.forEach((pattern, index) => {
    if (pattern.kind === 'PBind' && pattern.name !== 'result') {
      params.push({ name: pattern.name, index })
    }
  })
  return params
}

interface Observed extends Observation {
  /** The whole argument tuple, as text: equal for equal inputs. */
  readonly key: string
  readonly keys: readonly string[]
}

function observe(tree: CallTree, call: CallNode): Observed {
  const recording = tree.recording
  const details = tree.details(call)
  const before = details.args.map((arg) => plainValue(recording, call.entry, arg.value))
  // At its `Return` the callee's frame still holds the parameters, as its postconditions see them.
  const after = details.args.map((arg, i) =>
    arg.value.kind === 'ref' ? plainValue(recording, call.exit, arg.value) : before[i]!,
  )
  const result =
    details.result === null ? null : plainValue(recording, call.exit, details.result.value)
  const keys = before.map(plainKey)
  return {
    entry: call.entry,
    before,
    after,
    result,
    example: `${callSignature(details)} ${outcomeText(details)}`,
    keys,
    key: keys.join('\u0000'),
  }
}

/** The candidate with its support, when it held in every call and enough inputs bore on it. */
function supported(
  candidate: Candidate,
  observations: readonly Observed[],
  keys: readonly string[],
  minInputs: number,
): Scored[] {
  if (!observations.every((o) => candidate.holds(o) === true)) return []
  const bearing = observations.filter((o) => candidate.informative(o))
  const inputKey = (o: Observed): string =>
    candidate.reads.length === 0 ? o.key : candidate.reads.map((i) => o.keys[i]).join('\u0000')
  const inputs = new Set(bearing.map(inputKey)).size
  if (inputs < minInputs || bearing.length === 0 || keys.length === 0) return []
  const first = bearing[0]!
  return [
    {
      candidate,
      suggestion: {
        kind: candidate.kind,
        clause: candidate.clause,
        template: candidate.template,
        pins: candidate.pins,
        support: { calls: bearing.length, inputs },
        example: { text: first.example, entry: first.entry },
      },
    },
  ]
}

interface Scored {
  readonly candidate: Candidate
  readonly suggestion: ContractSuggestion
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Drops clauses that others imply: with a pinning clause, every other postcondition (the result
 * is determined); a type or nil check of a variable another kept clause can only satisfy with one
 * type; a nil check next to a type check or a length clause; `len(result) > 0` when a
 * precondition makes a parameter non-empty and the result is at least as long.
 */
function prune(scored: readonly Scored[]): Scored[] {
  const pins = rank(scored.filter((s) => s.candidate.pins)).slice(0, MAX_PINS)
  const pinned = new Set(pins.map((s) => s.suggestion.clause))
  const rest = scored.filter((s) =>
    pins.length > 0 ? s.candidate.kind === 'requires' || pinned.has(s.suggestion.clause) : true,
  )
  const typed = new Set(
    rest.filter((s) => s.candidate.typed).map((s) => `${s.candidate.kind} ${s.candidate.subject}`),
  )
  const typeChecked = new Set(
    rest
      .filter((s) => s.candidate.template === 'type')
      .map((s) => `${s.candidate.kind} ${s.candidate.subject}`),
  )
  const sized = new Set(
    rest
      .filter((s) => s.candidate.template === 'non-empty' || s.candidate.template === 'length')
      .map((s) => `${s.candidate.kind} ${s.candidate.subject}`),
  )
  const nonEmptyParams = new Set(
    rest
      .filter((s) => s.candidate.kind === 'requires' && s.candidate.template === 'non-empty')
      .map((s) => s.candidate.subject),
  )
  return rest.filter((s) => {
    const { candidate } = s
    const subject = `${candidate.kind} ${candidate.subject}`
    if ((candidate.template === 'type' || candidate.template === 'non-nil') && typed.has(subject)) {
      return false
    }
    if (candidate.template === 'non-nil' && (typeChecked.has(subject) || sized.has(subject))) {
      return false
    }
    if (candidate.kind === 'ensures' && candidate.template === 'non-empty') {
      return !rest.some(
        (other) =>
          other.candidate.template === 'length' &&
          /^len\(result\) (==|>=) len\((\w+)\)$/.test(other.suggestion.clause) &&
          nonEmptyParams.has(/len\((\w+)\)$/.exec(other.suggestion.clause)![1]!),
      )
    }
    return true
  })
}

/** Pinning clauses first, then by support (inputs, then calls), then by template. */
function rank(scored: readonly Scored[]): Scored[] {
  return [...scored].sort(
    (a, b) =>
      Number(b.suggestion.pins) - Number(a.suggestion.pins) ||
      b.suggestion.support.inputs - a.suggestion.support.inputs ||
      b.suggestion.support.calls - a.suggestion.support.calls ||
      TEMPLATE_PRIORITY[a.suggestion.template] - TEMPLATE_PRIORITY[b.suggestion.template],
  )
}

// --- verification -------------------------------------------------------------------------------

/** The clauses of `suggestions`, written in header order: preconditions, then postconditions. */
export function clauseTexts(suggestions: readonly ContractSuggestion[]): ClauseText[] {
  const order = (kind: string) => (kind === 'requires' ? 0 : 1)
  return [...suggestions]
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map((s) => ({ kind: s.kind, text: s.clause }))
}

/** The source with the chosen suggestions added to their functions' headers. */
export function withContracts(
  source: string,
  picks: readonly {
    readonly functionStart: number
    readonly suggestions: readonly ContractSuggestion[]
  }[],
): string {
  return insertContracts(
    source,
    picks.map((pick) => ({
      functionStart: pick.functionStart,
      clauses: clauseTexts(pick.suggestions),
    })),
  ).source
}

function verify(
  tools: InferTools,
  recording: Recording,
  functions: readonly FunctionContracts[],
  options: InferOptions,
): InferResult {
  let current: readonly FunctionContracts[] = functions
  const maxSteps = options.maxSteps ?? checkSteps(recording)
  let withdrawn = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const picks = current.filter((f) => f.suggestions.length > 0)
    if (picks.length === 0) return { functions: current, verified: true, withdrawn, problem: null }
    const written = picks.map((f) => ({
      functionStart: f.functionStart,
      clauses: clauseTexts(f.suggestions),
    }))
    const inserted = insertContracts(recording.program.source, written)
    const failed = failingClause(
      tools,
      recording,
      inserted.source,
      inserted.placed,
      maxSteps,
      options,
    )
    if (failed === 'ok') return { functions: current, verified: true, withdrawn, problem: null }
    if (failed === 'differs') {
      return {
        functions: current.map(withoutSuggestions),
        verified: false,
        withdrawn,
        problem: 'the program behaved differently with the clauses added, so none could be checked',
      }
    }
    const clause = written.find((w) => w.functionStart === failed.functionStart)!.clauses[
      failed.index
    ]!
    current = current.map((f) =>
      f.functionStart !== failed.functionStart
        ? f
        : {
            ...f,
            suggestions: f.suggestions.filter(
              (s) => s.kind !== clause.kind || s.clause !== clause.text,
            ),
          },
    )
    withdrawn += 1
  }
  return {
    functions: current.map(withoutSuggestions),
    verified: false,
    withdrawn,
    problem: 'too many clauses failed the check',
  }
}

/**
 * Steps for a check: clauses add work to every call, so a run that ended gets room to spare; a run
 * cut short is only compared as far as it got, so its check stops not far past the same point.
 */
function checkSteps(recording: Recording): number {
  const ended = recording.outcome.kind !== 'step-limit' && recording.outcome.kind !== 'aborted'
  const factor = ended ? CHECK_FACTOR_ENDED : CHECK_FACTOR_CUT
  return Math.min(MAX_CHECK_STEPS, Math.max(MIN_CHECK_STEPS, recording.length * factor))
}

function withoutSuggestions(f: FunctionContracts): FunctionContracts {
  return {
    ...f,
    suggestions: [],
    note: f.suggestions.length > 0 ? 'the suggestions could not be checked' : f.note,
  }
}

/** Records the program with the clauses: 'ok', the clause that failed, or 'differs'. */
function failingClause(
  tools: InferTools,
  recording: Recording,
  source: string,
  placed: readonly PlacedClause[],
  maxSteps: number,
  options: InferOptions,
): 'ok' | 'differs' | PlacedClause {
  const inClause = (offset: number) => placed.find((p) => offset >= p.start && offset <= p.end)
  const compiled = tools.compile(source)
  if (!compiled.ok) {
    const found = compiled.diagnostics
      .map((d) => inClause(d.span.start))
      .find((p) => p !== undefined)
    return found ?? 'differs'
  }
  const checked = tools.record(compiled.program, {
    maxSteps,
    seed: options.seed,
    snapshotBudget: CHECK_SNAPSHOTS,
  })
  const { outcome } = checked
  if (outcome.kind === 'error') {
    const found = inClause(outcome.error.span.start)
    if (found !== undefined) return found
  }
  return sameBehavior(recording, checked) ? 'ok' : 'differs'
}

/** The same outcome (a step limit counts as the same) and the same output. */
function sameBehavior(a: Recording, b: Recording): boolean {
  const x = a.outcome
  const y = b.outcome
  if (x.kind === 'step-limit' || x.kind === 'aborted') {
    return b.outputs.every((o, i) => i >= a.outputs.length || a.outputs[i]!.text === o.text)
  }
  if (x.kind !== y.kind) return false
  if (x.kind === 'error' && y.kind === 'error') {
    if (x.error.code !== y.error.code || x.error.message !== y.error.message) return false
  }
  return (
    a.outputs.length === b.outputs.length &&
    a.outputs.every((o, i) => o.text === b.outputs[i]!.text)
  )
}
