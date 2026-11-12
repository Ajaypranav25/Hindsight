/**
 * Negative provenance (ARCHITECTURE §7.10): "why didn't this line run?". `origin` explains where a
 * value came from; this explains an absence. The line's statement is found in the syntax tree with
 * the constructs that guard it (the `if`, loop, `match` arm or function around it). Going outwards
 * from the innermost, the first guard whose condition was evaluated is the one that kept control
 * away: its last decision is replayed and its operands are explained with `origin` ("total was 75,
 * set at step 810"). A function nobody called is explained through its first call site.
 */
import type { Recording, StateView, ValueView, WriteTarget } from './api-types'
import type * as ast from './ast'
import { Op } from './bytecode'
import { PREVIEW_LENGTH, valueText } from './call-values'
import { parse } from './parser'
import { replayAccess } from './recorder'
import { LineIndex, type Span } from './span'
import { preview } from './values'

export interface WhyNotOperand {
  readonly name: string
  readonly value: string
  /** The write that gave the operand its value, when one was recorded. */
  readonly origin: { readonly time: number; readonly line: number | null } | null
}

export type GuardConstruct = 'if' | 'else' | 'while' | 'for' | 'match'

export type WhyNot =
  /** The line did run. */
  | {
      readonly kind: 'ran'
      readonly line: number
      readonly hits: number
      readonly sentence: string
    }
  /** Nothing on the line can run (blank, a comment, a closing brace). */
  | { readonly kind: 'no-code'; readonly line: number; readonly sentence: string }
  | {
      readonly kind: 'guard'
      readonly line: number
      readonly construct: GuardConstruct
      readonly guardLine: number
      /** The source text of the condition, loop source or `match` subject. */
      readonly condition: string
      /** What it evaluated to the last time. */
      readonly value: string
      /** The step just after the last evaluation: the moment the decision was made. */
      readonly time: number
      /** How many times it was evaluated. */
      readonly checks: number
      readonly operands: readonly WhyNotOperand[]
      readonly sentence: string
    }
  | {
      readonly kind: 'never-called'
      readonly line: number
      readonly functionName: string
      /** Why the first call site did not run, when there is one that did not. */
      readonly callSite: WhyNot | null
      readonly sentence: string
    }
  /** Its block was entered, but control always left before reaching the line. */
  | {
      readonly kind: 'cut-short'
      readonly line: number
      /** A moment to look at: the end of the run when that is what cut it short; else null. */
      readonly time: number | null
      readonly sentence: string
    }

type Guard =
  | { readonly kind: 'if'; readonly node: ast.IfExpr; readonly branch: 'then' | 'else' }
  | { readonly kind: 'while'; readonly node: ast.WhileStmt }
  | { readonly kind: 'for'; readonly node: ast.ForStmt }
  | { readonly kind: 'arm'; readonly match: ast.MatchExpr; readonly arm: ast.MatchArm }
  | { readonly kind: 'fn'; readonly node: ast.FunctionExpr; readonly name: string | null }

interface Found {
  /** The innermost statement or expression body covering the line. */
  readonly span: Span
  /** Outermost first. */
  readonly guards: readonly Guard[]
}

const MAX_OPERANDS = 4
const MAX_CALL_SITE_DEPTH = 3
const TEXT_LIMIT = 60

/** Explains why `line` (1-based, in the main source) did not run. */
export function whyNot(recording: Recording, line: number): WhyNot {
  return explain(new Context(recording), line, 0)
}

class Context {
  readonly source: string
  readonly lines: LineIndex
  readonly program: ast.Program
  private hits: HitIndex | null = null

  constructor(readonly recording: Recording) {
    this.source = recording.program.source
    this.lines = new LineIndex(this.source)
    this.program = parse(this.source).program
  }

  text(span: Span): string {
    const text = this.source.slice(span.start, span.end).replace(/\s+/g, ' ').trim()
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text
  }

  lineOf(offset: number): number {
    return this.lines.lineOf(offset)
  }

  /** How often, and when last, an instruction whose span lies inside `span` executed. */
  within(span: Span): { readonly count: number; readonly last: number; readonly first: number } {
    this.hits ??= new HitIndex(this.recording)
    return this.hits.within(span)
  }
}

/** Execution counts per instruction of the main program, from one pass over the trace. */
class HitIndex {
  private readonly rows: {
    readonly start: number
    readonly end: number
    readonly count: number
    readonly first: number
    readonly last: number
  }[] = []

  constructor(recording: Recording) {
    const access = replayAccess(recording)
    if (access === null) return
    const { steps, length } = access.core
    const counts = new Map<number, { count: number; first: number; last: number }>()
    for (let t = 0; t < length; t++) {
      const key = steps.protoIds[t]! * 0x100000 + steps.ips[t]!
      const entry = counts.get(key)
      if (entry === undefined) counts.set(key, { count: 1, first: t, last: t })
      else {
        entry.count += 1
        entry.last = t
      }
    }
    for (const [key, entry] of counts) {
      const proto = access.table.proto(Math.floor(key / 0x100000))
      if (proto.debug.source !== 'main') continue
      const ip = key % 0x100000
      // Jumps consume what was evaluated; the last step *before* them is the evaluation's end.
      if (proto.code[ip] === Op.JumpIfFalse || proto.code[ip] === Op.Jump) continue
      const start = proto.debug.spanStart[ip] ?? 0
      const end = proto.debug.spanEnd[ip] ?? 0
      if (end > start) this.rows.push({ start, end, ...entry })
    }
  }

  within(span: Span): { count: number; last: number; first: number } {
    let count = 0
    let last = -1
    let first = Infinity
    for (const row of this.rows) {
      if (row.start < span.start || row.end > span.end) continue
      count += row.count
      if (row.last > last) last = row.last
      if (row.first < first) first = row.first
    }
    return { count, last, first }
  }
}

function explain(context: Context, line: number, depth: number): WhyNot {
  const outside = !Number.isInteger(line) || line < 1 || line > context.lines.lineCount
  const text = outside ? '' : context.lines.lineText(line).trim()
  const found =
    text === '' || text.startsWith('//') || /^[)\]}]+,?$/.test(text) ? null : locate(context, line)
  if (found === null) {
    return { kind: 'no-code', line, sentence: `There is no code on line ${line} to run.` }
  }
  const ran = context.within(found.span).count
  if (ran > 0) {
    const hits = context.recording.lineHitCounts().get(line) ?? ran
    const times = hits === 1 ? 'once' : `${hits.toLocaleString('en-US')} times`
    return { kind: 'ran', line, hits, sentence: `Line ${line} did run (${times}).` }
  }
  for (let i = found.guards.length - 1; i >= 0; i--) {
    const guard = found.guards[i]!
    if (guard.kind === 'fn') {
      if (context.within(guard.node.body.span).count > 0) break
      return neverCalled(context, line, guard, depth)
    }
    const decision = decisionOf(guard)
    if (context.within(decision.checked).count === 0) continue
    if (context.within(decision.branch).count > 0) break
    const explanation = guardExplanation(context, line, guard, decision)
    // The decision went the line's way after all (the branch held nothing but a `break`, which
    // leaves no step of its own): control entered and left early.
    if (wentTheLinesWay(explanation)) break
    return explanation
  }
  return cutShort(context, line)
}

// --- finding the line in the tree -----------------------------------------------------------------

function locate(context: Context, line: number): Found | null {
  const covers = (span: Span): boolean =>
    span.end > span.start &&
    context.lineOf(span.start) <= line &&
    context.lineOf(span.end - 1) >= line

  const inStatements = (
    statements: readonly ast.Stmt[],
    guards: readonly Guard[],
  ): Found | null => {
    for (const statement of statements) {
      if (!covers(statement.span)) continue
      return inStatement(statement, guards) ?? { span: statement.span, guards }
    }
    return null
  }

  const inBody = (body: ast.Block | ast.Expr, guards: readonly Guard[]): Found | null => {
    if (!covers(body.span)) return null
    if (body.kind === 'Block') return inStatements(body.body, guards)
    return inExpr(body, guards) ?? { span: body.span, guards }
  }

  const inStatement = (statement: ast.Stmt, guards: readonly Guard[]): Found | null => {
    switch (statement.kind) {
      case 'ExprStmt':
        return inExpr(statement.expr, guards)
      case 'Let':
        return inExpr(statement.init, guards)
      case 'FnDecl':
        return inBody(statement.fn.body, [
          ...guards,
          { kind: 'fn', node: statement.fn, name: statement.name },
        ])
      case 'Assign':
        return inExpr(statement.value, guards) ?? inExpr(statement.target, guards)
      case 'Return':
        return statement.value === null ? null : inExpr(statement.value, guards)
      case 'While':
        return (
          inExpr(statement.cond, guards) ??
          inBody(statement.body, [...guards, { kind: 'while', node: statement }])
        )
      case 'For':
        return (
          inExpr(statement.iterable, guards) ??
          inBody(statement.body, [...guards, { kind: 'for', node: statement }])
        )
      case 'BlockStmt':
        return inStatements(statement.block.body, guards)
      default:
        return null
    }
  }

  const inExprs = (exprs: readonly ast.Expr[], guards: readonly Guard[]): Found | null => {
    for (const expr of exprs) {
      const found = inExpr(expr, guards)
      if (found !== null) return found
    }
    return null
  }

  const inExpr = (expr: ast.Expr, guards: readonly Guard[]): Found | null => {
    if (!covers(expr.span)) return null
    switch (expr.kind) {
      case 'Template':
        return inExprs(expr.exprs, guards)
      case 'List':
        return inExprs(
          expr.items.map((item) => (item.kind === 'Spread' ? item.expr : item)),
          guards,
        )
      case 'Record':
        return inExprs(
          expr.items.map((item) => (item.kind === 'Spread' ? item.expr : item.value)),
          guards,
        )
      case 'Unary':
        return inExpr(expr.operand, guards)
      case 'Binary':
      case 'Logical':
        return inExprs([expr.left, expr.right], guards)
      case 'Call':
        return inExprs([expr.callee, ...expr.args], guards)
      case 'Index':
        return inExprs([expr.object, expr.index], guards)
      case 'Member':
        return inExpr(expr.object, guards)
      case 'Function':
        return inBody(expr.body, [...guards, { kind: 'fn', node: expr, name: expr.name }])
      case 'If': {
        const here = (branch: 'then' | 'else'): Guard[] => [
          ...guards,
          { kind: 'if', node: expr, branch },
        ]
        if (covers(expr.cond.span)) return inExpr(expr.cond, guards)
        if (covers(expr.then.span)) return inStatements(expr.then.body, here('then'))
        if (expr.else === null || !covers(expr.else.span)) return null
        return expr.else.kind === 'Block'
          ? inStatements(expr.else.body, here('else'))
          : (inExpr(expr.else, here('else')) ?? { span: expr.else.span, guards: here('else') })
      }
      case 'Match': {
        if (covers(expr.subject.span)) return inExpr(expr.subject, guards)
        for (const arm of expr.arms) {
          if (!covers(arm.span)) continue
          const inside: Guard[] = [...guards, { kind: 'arm', match: expr, arm }]
          return inBody(arm.body, inside) ?? { span: arm.body.span, guards: inside }
        }
        return null
      }
      default:
        return null
    }
  }

  return inStatements(context.program.body, [])
}

// --- guards -------------------------------------------------------------------------------------

interface Decision {
  /** What is evaluated to decide (the condition, the loop source, the `match` subject). */
  readonly checked: Span
  /** What runs when the decision goes the line's way. */
  readonly branch: Span
  readonly construct: GuardConstruct
  readonly expr: ast.Expr
}

function decisionOf(guard: Exclude<Guard, { kind: 'fn' }>): Decision {
  switch (guard.kind) {
    case 'if': {
      const { node, branch } = guard
      const taken = branch === 'then' ? node.then.span : (node.else?.span ?? node.then.span)
      return {
        checked: node.cond.span,
        branch: taken,
        construct: branch === 'then' ? 'if' : 'else',
        expr: node.cond,
      }
    }
    case 'while':
      return {
        checked: guard.node.cond.span,
        branch: guard.node.body.span,
        construct: 'while',
        expr: guard.node.cond,
      }
    case 'for':
      return {
        checked: guard.node.iterable.span,
        branch: guard.node.body.span,
        construct: 'for',
        expr: guard.node.iterable,
      }
    case 'arm':
      return {
        checked: guard.match.subject.span,
        branch: guard.arm.body.span,
        construct: 'match',
        expr: guard.match.subject,
      }
  }
}

function guardExplanation(
  context: Context,
  line: number,
  guard: Exclude<Guard, { kind: 'fn' }>,
  decision: Decision,
): WhyNot {
  const { recording } = context
  const evaluated = context.within(decision.checked)
  const time = decisionTime(recording, evaluated.last)
  const state = recording.stateAt(time)
  const value = topOfStack(recording, time)
  const condition = context.text(decision.checked)
  const operands = operandsOf(context, decision.expr, state, time)
  const guardLine = context.lineOf(decision.checked.start)
  // How often the decision was made: the executions of the first thing it evaluates.
  const checks = Math.max(1, firstInstructionHits(context, decision.checked))
  const base = { line, construct: decision.construct, guardLine, condition, value, time, checks }
  const sentence = guardSentence(context, guard, base, operands)
  return { kind: 'guard', ...base, operands, sentence }
}

/** The value on top of the operand stack at `time`: what was just evaluated. */
function topOfStack(recording: Recording, time: number): string {
  const stack = replayAccess(recording)?.newSeeker().positionAt(time).stack ?? []
  return stack.length === 0 ? 'unknown' : preview(stack[stack.length - 1]!, PREVIEW_LENGTH)
}

function wentTheLinesWay(why: WhyNot): boolean {
  if (why.kind !== 'guard') return false
  const falsy = why.value === 'false' || why.value === 'nil'
  if (why.construct === 'if' || why.construct === 'while') return !falsy
  return why.construct === 'else' && falsy
}

/** The first step after `last` back at its depth: the evaluated value is then on the stack. */
function decisionTime(recording: Recording, last: number): number {
  const depths = recording.depthSeries()
  const depth = depths[last]!
  let time = last + 1
  while (time < recording.length && depths[time]! > depth) time++
  return Math.min(time, recording.length)
}

function firstInstructionHits(context: Context, span: Span): number {
  // The narrowest probe that still contains one instruction: grow from the span's start.
  for (let end = span.start + 1; end <= span.end; end++) {
    const { count } = context.within({ start: span.start, end })
    if (count > 0) return count
  }
  return 0
}

function guardSentence(
  context: Context,
  guard: Exclude<Guard, { kind: 'fn' }>,
  base: { line: number; condition: string; value: string; time: number; checks: number },
  operands: readonly WhyNotOperand[],
): string {
  const { line, condition, value, time, checks } = base
  const step = `step ${time.toLocaleString('en-US')}`
  const every =
    checks === 1
      ? `at ${step}`
      : `each of the ${checks.toLocaleString('en-US')} times it was checked; the last time, at ${step}`
  const detail = operands.length === 0 ? '' : ` (${operands.map(operandText).join('; ')})`
  switch (guard.kind) {
    case 'if':
    case 'while':
      return `Line ${line} never ran because ${every}, \`${condition}\` was ${value}${detail}.`
    case 'for':
      return `Line ${line} never ran because ${every}, \`${condition}\` was ${value}: there was nothing to loop over${detail}.`
    case 'arm': {
      const pattern = context.text(guard.arm.pattern.span)
      const guarded = guard.arm.guard === null ? '' : ` if ${context.text(guard.arm.guard.span)}`
      return `Line ${line} never ran because ${every}, \`${condition}\` was ${value}, which the arm \`${pattern}${guarded}\` did not take${detail}.`
    }
  }
}

function operandText(operand: WhyNotOperand): string {
  if (operand.origin === null) return `${operand.name} was ${operand.value}`
  const where = operand.origin.line === null ? '' : ` on line ${operand.origin.line}`
  return `${operand.name} was ${operand.value}, set at step ${operand.origin.time.toLocaleString('en-US')}${where}`
}

/** The variables `expr` reads, with their values at `time` and where those came from. */
function operandsOf(
  context: Context,
  expr: ast.Expr,
  state: StateView,
  time: number,
): WhyNotOperand[] {
  const { recording } = context
  const operands: WhyNotOperand[] = []
  for (const name of identifiers(expr)) {
    const variable = visible(state, name)
    if (variable === null) continue
    // Functions are not what a decision turned on.
    if (variable.value.kind === 'ref' && isFunction(variable.value)) continue
    const event = recording.origin(variable.target, time)
    const location = event === null ? null : recording.locationAt(event.time)
    operands.push({
      name,
      value: valueText(variable.value),
      origin:
        event === null
          ? null
          : { time: event.time, line: location?.source === 'main' ? location.line : null },
    })
    if (operands.length >= MAX_OPERANDS) break
  }
  return operands
}

function isFunction(value: ValueView): boolean {
  return value.kind === 'ref' && (value.type === 'function' || value.type === 'builtin')
}

function visible(
  state: StateView,
  name: string,
): { readonly value: ValueView; readonly target: WriteTarget } | null {
  const frame = state.frames.at(-1)
  return (
    frame?.locals.findLast((local) => local.name === name) ??
    frame?.captures.find((capture) => capture.name === name) ??
    state.globals.find((global) => global.name === name) ??
    null
  )
}

/** The distinct identifiers `expr` reads, in source order (an explicit work list). */
function identifiers(expr: ast.Expr): string[] {
  const names: string[] = []
  const work: ast.Expr[] = [expr]
  while (work.length > 0) {
    const node = work.shift()!
    switch (node.kind) {
      case 'Ident':
        if (!names.includes(node.name)) names.push(node.name)
        break
      case 'Unary':
        work.push(node.operand)
        break
      case 'Binary':
      case 'Logical':
        work.push(node.left, node.right)
        break
      case 'Call':
        work.push(node.callee, ...node.args)
        break
      case 'Index':
        work.push(node.object, node.index)
        break
      case 'Member':
        work.push(node.object)
        break
      case 'Template':
        work.push(...node.exprs)
        break
      case 'List':
        work.push(...node.items.map((item) => (item.kind === 'Spread' ? item.expr : item)))
        break
      default:
        break
    }
  }
  return names
}

// --- functions nobody called, and blocks left early ---------------------------------------------

function neverCalled(
  context: Context,
  line: number,
  guard: Extract<Guard, { kind: 'fn' }>,
  depth: number,
): WhyNot {
  const functionName = guard.name ?? 'this function'
  const named = guard.name === null ? 'a function' : `function ${guard.name}`
  const lead = `Line ${line} is inside ${named}, which was never called`
  const sites = guard.name === null ? [] : callSites(context, guard.name)
  const idle = sites.filter((span) => context.within(span).count === 0)
  if (guard.name !== null && sites.length === 0) {
    return {
      kind: 'never-called',
      line,
      functionName,
      callSite: null,
      sentence: `${lead}: nothing in the program calls it by name.`,
    }
  }
  const site = idle[0]
  if (site === undefined || depth >= MAX_CALL_SITE_DEPTH) {
    return { kind: 'never-called', line, functionName, callSite: null, sentence: `${lead}.` }
  }
  const siteLine = context.lineOf(site.start)
  const callSite = explain(context, siteLine, depth + 1)
  const why = callSite.kind === 'ran' || callSite.kind === 'no-code' ? '' : ` ${callSite.sentence}`
  return {
    kind: 'never-called',
    line,
    functionName,
    callSite: why === '' ? null : callSite,
    sentence: `${lead}. Its call on line ${siteLine} did not run.${why}`,
  }
}

/** The spans of the calls `name(...)` in the program (by name only: shadowing is not resolved). */
function callSites(context: Context, name: string): Span[] {
  const sites: Span[] = []
  const pattern = new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\(`, 'g')
  for (const match of context.source.matchAll(pattern)) {
    const start = match.index
    const lineStart = context.source.lastIndexOf('\n', start) + 1
    const before = context.source.slice(lineStart, start)
    // Not the declaration itself, and not text inside a comment.
    if (/\bfn\s+$/.test(before) || before.includes('//')) continue
    sites.push({ start, end: start + name.length })
  }
  return sites
}

function cutShort(context: Context, line: number): WhyNot {
  const { recording } = context
  const outcome = recording.outcome
  if (outcome.kind === 'error') {
    const errorLine = context.lineOf(outcome.error.span.start)
    return {
      kind: 'cut-short',
      line,
      time: recording.length,
      sentence: `Line ${line} never ran: the run stopped with an error on line ${errorLine} before reaching it.`,
    }
  }
  if (outcome.kind !== 'finished') {
    return {
      kind: 'cut-short',
      line,
      time: recording.length,
      sentence: `Line ${line} never ran: the recording stopped before reaching it.`,
    }
  }
  return {
    kind: 'cut-short',
    line,
    time: null,
    sentence: `Line ${line} never ran: every time its block ran, control left (a return, break or continue) before reaching it.`,
  }
}
