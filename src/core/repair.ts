/**
 * Repair previews (ARCHITECTURE §7.12): once the bug finder has isolated a function, or a run has
 * crashed in one, try the small edits a programmer would try first and report the ones that make
 * the evidence come out right. An edit is one operator or literal changed inside that function
 * (`+` ↔ `-`, `<` → `<=`, `1` → `0`, `and` ↔ `or`, …). Each mutant is compiled and recorded from
 * the start (a snapshot belongs to the program it was taken from, and whole runs are cheap), then
 * checked against the oracle: every call the user judged right must still give that answer, every
 * call judged wrong must now return something else, and the run must not crash or run away.
 *
 * A repair that passes is a *preview*, not a proof: it is consistent with the answers given so
 * far. The search is a generator so a page can run it between frames.
 */
import type { CompileResult, RecordOptions, Recording } from './api-types'
import type * as ast from './ast'
import type { Program } from './bytecode'
import type { FinderState } from './bug-finder'
import { changeTexts, outcomeText } from './bug-finder-text'
import { type CallDetails, type CallTree, callTree } from './calls'
import { parse } from './parser'
import { replayAccess } from './recorder'
import { LineIndex, type Span } from './span'

/** A call the user judged: its arguments as shown, and what it did. */
export interface RepairExample {
  readonly name: string
  /** The argument texts at entry, in order. */
  readonly args: readonly string[]
  /** What the call did (its result and what it changed), as the question showed it. */
  readonly did: string
  readonly answer: 'right' | 'wrong'
}

export type RepairRequest =
  /** Repair function `protoId` so that the judged calls come out right. */
  | {
      readonly kind: 'examples'
      readonly protoId: number
      readonly examples: readonly RepairExample[]
    }
  /** Repair the function a failed run crashed in so that the run finishes. */
  | { readonly kind: 'crash' }

export interface Repair {
  /** 1-based line of the change. */
  readonly line: number
  /** What changed: "`<` → `<=`". */
  readonly change: string
  /** The line before and after. */
  readonly before: string
  readonly after: string
  /**
   * What the calls judged wrong do with the repair ("average(scores = [92, 88, 95]) now returned
   * 91.66666666666667"), so the right repair can be told from one that is merely different.
   */
  readonly now: readonly string[]
  /** The whole repaired program. */
  readonly source: string
}

export interface RepairResult {
  readonly repairs: readonly Repair[]
  /** Mutants compiled and run. */
  readonly tried: number
  /** True when the budget ran out before every mutant was tried. */
  readonly exhausted: boolean
  readonly problem: string | null
}

export interface RepairOptions {
  /** The most mutants run. Default 150. */
  readonly maxMutants?: number
  /** Stop after this many repairs. Default 5. */
  readonly maxRepairs?: number
}

/** What the search needs from the pipeline (index.ts supplies `compile` and `record`). */
export interface RepairTools {
  compile(source: string): CompileResult
  record(program: Program, options: RecordOptions): Recording
}

/** Yields the number of mutants tried so far after each one; returns the result. */
export type RepairSearch = Generator<number, RepairResult, void>

const DEFAULT_MAX_MUTANTS = 150
const DEFAULT_MAX_REPAIRS = 5
/** The most calls of one function checked against the examples in a mutant's run. */
const MAX_CALLS_CHECKED = 400

/** The examples an interview has produced: the calls the user judged right or wrong. */
export function repairExamples(tree: CallTree, state: FinderState): RepairExample[] {
  const examples: RepairExample[] = []
  for (const judgment of state.judgments) {
    if (judgment.remembered || judgment.answer === 'unsure') continue
    const details = tree.details(judgment.call)
    examples.push({ ...signature(details), answer: judgment.answer })
  }
  return examples
}

function signature(details: CallDetails): Omit<RepairExample, 'answer'> {
  return {
    name: details.call.name,
    args: details.args.map((arg) => arg.text),
    did: [outcomeText(details), ...changeTexts(details)].join('; '),
  }
}

// --- mutation sites -------------------------------------------------------------------------------

interface Site {
  readonly span: Span
  readonly replacements: readonly string[]
}

const BINARY_SWAPS: Readonly<Record<string, readonly string[]>> = {
  '+': ['-'],
  '-': ['+'],
  '*': ['/'],
  '/': ['*'],
  '%': ['/'],
  '<': ['<=', '>'],
  '<=': ['<', '>='],
  '>': ['>=', '<'],
  '>=': ['>', '<='],
  '==': ['!='],
  '!=': ['=='],
  '..': ['..='],
  '..=': ['..'],
}

const ASSIGN_SWAPS: Readonly<Record<string, readonly string[]>> = {
  '+=': ['-=', '='],
  '-=': ['+='],
  '*=': ['/='],
  '/=': ['*='],
}

/** The operators and literals inside `within` (or, for the top level, outside every function). */
function sitesOf(source: string, program: ast.Program, within: Span | null): Site[] {
  const sites: Site[] = []
  const inside = (span: Span): boolean =>
    within === null || (span.start >= within.start && span.end <= within.end)
  /** The operator text between two operands: the source between them, trimmed. */
  const between = (left: Span, right: Span): Span => {
    const text = source.slice(left.end, right.start)
    const start = left.end + (text.length - text.trimStart().length)
    return { start, end: start + text.trim().length }
  }
  const add = (span: Span, replacements: readonly string[] | undefined): void => {
    if (replacements !== undefined && inside(span)) sites.push({ span, replacements })
  }

  const expr = (node: ast.Expr | ast.Spread): void => {
    switch (node.kind) {
      case 'Spread':
        expr(node.expr)
        break
      case 'Number': {
        const variants = [node.value + 1, node.value - 1, 0, 1]
          .filter((value, i, all) => value !== node.value && value >= 0 && all.indexOf(value) === i)
          .map(String)
        add(node.span, variants)
        break
      }
      case 'Bool':
        add(node.span, [node.value ? 'false' : 'true'])
        break
      case 'Template':
        node.exprs.forEach(expr)
        break
      case 'List':
        node.items.forEach(expr)
        break
      case 'Record':
        for (const item of node.items) expr(item.kind === 'Spread' ? item : item.value)
        break
      case 'Unary':
        expr(node.operand)
        break
      case 'Binary':
        add(node.opSpan, BINARY_SWAPS[node.op])
        expr(node.left)
        expr(node.right)
        break
      case 'Logical':
        add(between(node.left.span, node.right.span), [node.op === 'and' ? 'or' : 'and'])
        expr(node.left)
        expr(node.right)
        break
      case 'Call':
        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'Index':
        expr(node.object)
        expr(node.index)
        break
      case 'Member':
        expr(node.object)
        break
      case 'Function':
        // The top level's own code does not include the functions it declares.
        if (within !== null) body(node.body)
        break
      case 'If':
        expr(node.cond)
        block(node.then)
        if (node.else !== null) body(node.else)
        break
      case 'Match':
        expr(node.subject)
        for (const arm of node.arms) {
          if (arm.guard !== null) expr(arm.guard)
          body(arm.body)
        }
        break
      default:
        break
    }
  }
  const body = (node: ast.Block | ast.Expr): void => {
    if (node.kind === 'Block') block(node)
    else expr(node)
  }
  const block = (node: ast.Block): void => node.body.forEach(statement)
  const statement = (node: ast.Stmt): void => {
    switch (node.kind) {
      case 'ExprStmt':
        expr(node.expr)
        break
      case 'Let':
        expr(node.init)
        break
      case 'FnDecl':
        expr(node.fn)
        break
      case 'Assign':
        add(between(node.target.span, node.value.span), ASSIGN_SWAPS[node.op])
        expr(node.target)
        expr(node.value)
        break
      case 'Return':
        if (node.value !== null) expr(node.value)
        break
      case 'While':
        expr(node.cond)
        block(node.body)
        break
      case 'For':
        expr(node.iterable)
        block(node.body)
        break
      case 'BlockStmt':
        block(node.block)
        break
      default:
        break
    }
  }
  program.body.forEach(statement)
  return sites.sort((a, b) => a.span.start - b.span.start)
}

// --- the search ---------------------------------------------------------------------------------

/** What the judged-wrong calls do in the mutant's run, or null when the mutant fails. */
type Oracle = (mutant: Recording) => readonly string[] | null

export function* repairSearch(
  tools: RepairTools,
  recording: Recording,
  request: RepairRequest,
  options: RepairOptions = {},
): RepairSearch {
  const nothing = (problem: string): RepairResult => ({
    repairs: [],
    tried: 0,
    exhausted: false,
    problem,
  })
  const source = recording.program.source
  const planned = plan(recording, request)
  if (typeof planned === 'string') return nothing(planned)
  const sites = sitesOf(source, parse(source).program, planned.within)
  if (sites.length === 0) return nothing('There is no operator or number in that code to change.')
  const core = replayAccess(recording)?.core
  const limits: RecordOptions = {
    seed: core?.seed,
    // A mutant that loops for ever must stop soon.
    maxSteps: Math.max(recording.length * 4, recording.length + 50_000),
  }
  const lines = new LineIndex(source)
  const maxMutants = options.maxMutants ?? DEFAULT_MAX_MUTANTS
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS
  const repairs: Repair[] = []
  let tried = 0
  let exhausted = false
  search: for (const site of sites) {
    const original = source.slice(site.span.start, site.span.end)
    for (const replacement of site.replacements) {
      if (repairs.length >= maxRepairs) break search
      if (tried >= maxMutants) {
        exhausted = true
        break search
      }
      const mutated = source.slice(0, site.span.start) + replacement + source.slice(site.span.end)
      tried += 1
      const compiled = tools.compile(mutated)
      const now = compiled.ok ? planned.oracle(tools.record(compiled.program, limits)) : null
      if (now !== null) {
        const line = lines.lineOf(site.span.start)
        repairs.push({
          line,
          change: `\`${original}\` → \`${replacement}\``,
          before: lines.lineText(line),
          after: new LineIndex(mutated).lineText(line),
          now,
          source: mutated,
        })
      }
      yield tried
    }
  }
  return { repairs, tried, exhausted, problem: null }
}

interface Plan {
  /** The function to change; null for the top-level code. */
  readonly within: Span | null
  readonly oracle: Oracle
}

function plan(recording: Recording, request: RepairRequest): Plan | string {
  const { program } = recording
  if (request.kind === 'crash') {
    if (recording.outcome.kind !== 'error') return 'The run did not crash.'
    const frames = recording.stateAt(recording.length).frames
    const frame = frames.findLast((candidate) => !candidate.library)
    if (frame === undefined) return 'The crash is not in code of the program itself.'
    return {
      within: spanOf(recording, frame.protoId),
      oracle: (mutant) => (mutant.outcome.kind === 'finished' ? ['the run finishes'] : null),
    }
  }
  const wrong = request.examples.filter((example) => example.answer === 'wrong')
  if (wrong.length === 0) {
    return 'There is no call judged wrong to check a repair against.'
  }
  const crashed = recording.outcome.kind === 'error'
  return {
    within: request.protoId === program.script.id ? null : spanOf(recording, request.protoId),
    oracle: (mutant) =>
      crashed || mutant.outcome.kind === 'finished' ? satisfies(mutant, request.examples) : null,
  }
}

function spanOf(recording: Recording, protoId: number): Span | null {
  const { program } = recording
  if (protoId === program.script.id) return null
  return program.protos[protoId - program.firstProtoId]?.debug.span ?? null
}

/**
 * Checks the mutant's run against every example it can be checked against: null when one fails,
 * else what the calls judged wrong do now.
 */
function satisfies(mutant: Recording, examples: readonly RepairExample[]): string[] | null {
  const byCall = new Map<string, RepairExample>()
  for (const example of examples) byCall.set(callKey(example), example)
  const names = new Set(examples.map((example) => example.name))
  const tree = callTree(mutant)
  const fixed = new Map<string, string>()
  let checked = 0
  for (const call of tree.calls({ justMyCode: true })) {
    if (call.depth === 0 || !names.has(call.name)) continue
    if (checked++ >= MAX_CALLS_CHECKED) break
    const details = tree.details(call)
    const now = signature(details)
    const key = callKey(now)
    const example = byCall.get(key)
    if (example === undefined) continue
    if (example.answer === 'right' && now.did !== example.did) return null
    if (example.answer === 'wrong') {
      if (now.did === example.did || call.outcome !== 'returned') return null
      const shown = details.args.map((arg) => `${arg.name} = ${arg.text}`).join(', ')
      fixed.set(key, `${now.name}(${shown}) now ${now.did}`)
    }
  }
  // Every call judged wrong must have been made again, and come out differently.
  const all = examples.every((example) => example.answer !== 'wrong' || fixed.has(callKey(example)))
  return all ? [...fixed.values()] : null
}

function callKey(example: Pick<RepairExample, 'name' | 'args'>): string {
  return [example.name, ...example.args].join('\u0000')
}
