/**
 * The temporal query language (ARCHITECTURE §7.9). A recording is a small time-series database:
 * a flat trace of steps and a typed event log. A query jumps to moments by what was true then
 * instead of by scrubbing:
 *
 *   when xs.len > 10 and depth > 4     the stretches of the run where the condition held
 *   changed(order.paid)                every step that wrote that field, whatever the record was
 *                                      called where it was written (it is followed by object id)
 *   calls(fib) where ret < 0           the calls of a function, filtered by arguments and result
 *
 * Expressions are Hindsight expressions (parsed by the real parser) over the variables visible at
 * each moment, plus `depth`, `step`, `line`, `function` and, in `calls`, `ret`. `x.len` is short
 * for `len(x)`. Conditions are checked at statement starts in user code, by one replay of the run.
 */
import type { ProvenanceEvent, Recording, WriteTarget } from './api-types'
import type * as ast from './ast'
import { callTree } from './calls'
import { parse } from './parser'
import {
  check,
  evaluate,
  holds,
  type Moment,
  QUERY_FUNCTIONS,
  resolveName,
  Unknown,
} from './query-eval'
import { type ReplayAccess, replayAccess } from './recorder'
import type { Value, VM } from './runtime-types'
import { preview } from './values'

export type Query =
  | { readonly kind: 'when'; readonly condition: ast.Expr }
  | { readonly kind: 'changed'; readonly path: ast.Expr }
  | { readonly kind: 'calls'; readonly name: string; readonly where: ast.Expr | null }

export type QueryParse =
  { readonly ok: true; readonly query: Query } | { readonly ok: false; readonly error: string }

/** Steps `from..to` (exclusive) during which a `when` condition held. */
export interface QueryInterval {
  readonly from: number
  readonly to: number
}

export interface QueryCall {
  readonly entry: number
  /** The call's last step (its `Return`), or N when it never returned. */
  readonly exit: number
  /** `fib(n = 4) returned 3`, with the parameters as they were when it returned. */
  readonly text: string
}

export type QueryResult =
  | {
      readonly kind: 'when'
      readonly intervals: readonly QueryInterval[]
      /** Statement starts at which the condition held. */
      readonly matches: number
      readonly truncated: boolean
    }
  | {
      readonly kind: 'changed'
      readonly events: readonly ProvenanceEvent[]
      readonly total: number
      readonly truncated: boolean
    }
  | {
      readonly kind: 'calls'
      readonly calls: readonly QueryCall[]
      readonly total: number
      readonly truncated: boolean
    }

export type QueryOutcome =
  | { readonly ok: true; readonly result: QueryResult }
  | { readonly ok: false; readonly error: string }

export interface QueryOptions {
  /** The most intervals, events or calls returned. Default 1000. */
  readonly limit?: number
}

export const DEFAULT_QUERY_LIMIT = 1000
/** The most distinct places (`changed`) a query follows. */
const MAX_FOLLOWED = 500
const VALUE_TEXT = 40
const HELP = 'Try: when x > 10 and depth > 2 · changed(order.paid) · calls(fib) where ret < 0'

// --- parsing ------------------------------------------------------------------------------------

const CHANGED = /^changed\s*\(([\s\S]*)\)$/
const CALLS = /^calls\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)(?:\s*where\s+([\s\S]+))?$/
const WHEN = /^when\s+([\s\S]+)$/

export function parseQuery(text: string): QueryParse {
  const source = text.trim()
  if (source === '' || source === 'when') return { ok: false, error: `Type a query. ${HELP}` }
  const calls = CALLS.exec(source)
  if (calls !== null) {
    const where = calls[2] === undefined ? null : expression(calls[2])
    if (where !== null && typeof where === 'string') return { ok: false, error: where }
    return { ok: true, query: { kind: 'calls', name: calls[1]!, where } }
  }
  const changed = CHANGED.exec(source)
  if (changed !== null) {
    const path = expression(changed[1]!)
    if (typeof path === 'string') return { ok: false, error: path }
    if (!isPath(path)) {
      return {
        ok: false,
        error: 'changed(…) takes a variable, a field or an element: xs, o.f, xs[0]',
      }
    }
    return { ok: true, query: { kind: 'changed', path } }
  }
  const condition = expression(WHEN.exec(source)?.[1] ?? source)
  if (typeof condition === 'string') return { ok: false, error: condition }
  return { ok: true, query: { kind: 'when', condition } }
}

/** The expression `text` reads as, or the reason it cannot be a query expression. */
function expression(text: string): ast.Expr | string {
  const parsed = parse(text)
  const problem = parsed.diagnostics[0]
  if (problem !== undefined) return `${problem.message}. ${HELP}`
  const [statement, extra] = parsed.program.body
  if (statement === undefined || extra !== undefined || statement.kind !== 'ExprStmt') {
    return `A query takes one expression. ${HELP}`
  }
  return unsupported(statement.expr) ?? statement.expr
}

/** Why `expr` cannot be evaluated by a query, or null when it can. */
function unsupported(expr: ast.Expr): string | null {
  switch (expr.kind) {
    case 'Number':
    case 'String':
    case 'Bool':
    case 'Nil':
    case 'Ident':
      return null
    case 'Unary':
      return unsupported(expr.operand)
    case 'Binary':
      if (expr.op === '..' || expr.op === '..=') return 'Queries cannot build ranges'
      return unsupported(expr.left) ?? unsupported(expr.right)
    case 'Logical':
      return unsupported(expr.left) ?? unsupported(expr.right)
    case 'Member':
      return unsupported(expr.object)
    case 'Index':
      return unsupported(expr.object) ?? unsupported(expr.index)
    case 'Call': {
      const name = expr.callee.kind === 'Ident' ? expr.callee.name : null
      if (name === null || !(QUERY_FUNCTIONS as readonly string[]).includes(name)) {
        return `Queries can call only ${QUERY_FUNCTIONS.join(', ')}`
      }
      for (const arg of expr.args) {
        const problem = unsupported(arg)
        if (problem !== null) return problem
      }
      return null
    }
    default:
      return 'Queries take comparisons, arithmetic, fields, elements, and/or/not'
  }
}

function isPath(expr: ast.Expr): boolean {
  if (expr.kind === 'Ident') return true
  if (expr.kind === 'Member') return isPath(expr.object)
  if (expr.kind !== 'Index') return false
  return (expr.index.kind === 'Number' || expr.index.kind === 'String') && isPath(expr.object)
}

// --- running ------------------------------------------------------------------------------------

/** Parses and runs `text` against `recording`. */
export function queryRecording(
  recording: Recording,
  text: string,
  options: QueryOptions = {},
): QueryOutcome {
  const parsed = parseQuery(text)
  return parsed.ok ? runQuery(recording, parsed.query, options) : parsed
}

export function runQuery(
  recording: Recording,
  query: Query,
  options: QueryOptions = {},
): QueryOutcome {
  const access = replayAccess(recording)
  if (access === null) return { ok: false, error: 'This recording cannot be queried.' }
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_QUERY_LIMIT))
  switch (query.kind) {
    case 'when':
      return { ok: true, result: when(recording, access, query.condition, limit) }
    case 'changed':
      return changed(recording, access, query.path, limit)
    case 'calls':
      return calls(recording, access, query.name, query.where, limit)
  }
}

/** The moments a result points at, in time order: what a timeline marks. */
export function queryTimes(result: QueryResult): number[] {
  switch (result.kind) {
    case 'when':
      return result.intervals.map((interval) => interval.from)
    case 'changed':
      return result.events.map((event) => event.time)
    case 'calls':
      return result.calls.map((call) => call.entry)
  }
}

/** The statement starts in user code, in time order: where conditions are checked. */
function statementStarts(access: ReplayAccess): number[] {
  const { steps, length } = access.core
  const times: number[] = []
  let protoId = -1
  let user = false
  let starts: Uint8Array = new Uint8Array(0)
  for (let t = 0; t < length; t++) {
    if (steps.protoIds[t] !== protoId) {
      protoId = steps.protoIds[t]!
      const proto = access.table.proto(protoId)
      user = proto.debug.source === 'main'
      starts = proto.debug.stmtStart
    }
    if (user && starts[steps.ips[t]!] === 1) times.push(t)
  }
  return times
}

function scan(
  access: ReplayAccess,
  times: readonly number[],
  visit: (moment: Moment) => void,
): void {
  const seeker = access.newSeeker()
  for (const time of times) visit({ vm: seeker.positionAt(time), time, table: access.table })
}

function when(
  recording: Recording,
  access: ReplayAccess,
  condition: ast.Expr,
  limit: number,
): QueryResult {
  const intervals: QueryInterval[] = []
  let matches = 0
  let open = -1
  // The first moment since the condition last held at which it had no value (a loop header
  // between two iterations, where the loop variable is out of scope): the stretch goes on
  // through it if the condition holds again, and ends there if not.
  let unknownSince = -1
  let truncated = false
  const close = (end: number): void => {
    if (open < 0) return
    if (intervals.length < limit) intervals.push({ from: open, to: end })
    else truncated = true
    open = -1
  }
  scan(access, statementStarts(access), (moment) => {
    const held = check(condition, moment)
    if (held === true) {
      matches += 1
      if (open < 0) open = moment.time
      unknownSince = -1
    } else if (held === null) {
      if (open >= 0 && unknownSince < 0) unknownSince = moment.time
    } else {
      close(unknownSince >= 0 ? unknownSince : moment.time)
      unknownSince = -1
    }
  })
  close(unknownSince >= 0 ? unknownSince : recording.length)
  return { kind: 'when', intervals, matches, truncated }
}

// --- changed(path) ------------------------------------------------------------------------------

interface Followed {
  readonly target: WriteTarget
  /** A time at which the target was live (a local's history is that of the binding live then). */
  readonly at: number
}

function targetKey(target: WriteTarget): string {
  switch (target.kind) {
    case 'local':
      return `local ${target.frameUid} ${target.slot}`
    case 'global':
      return `global ${target.name}`
    case 'field':
      return `field ${target.objectId} ${target.key}`
    case 'element':
      return `element ${target.objectId} ${target.index}`
    case 'object':
      return `object ${target.objectId}`
    case 'cell':
      return `cell ${target.cellId}`
  }
}

/** The places `path` names at this moment: the variable itself, or a part of the object it holds. */
function placesOf(path: ast.Expr, moment: Moment): WriteTarget[] {
  if (path.kind === 'Ident') {
    const found = resolveName(moment.vm, path.name)
    if (found === null) return []
    const value = found.value
    const held = value !== null && typeof value === 'object' && value.id > 0
    return held ? [found.target, { kind: 'object', objectId: value.id }] : [found.target]
  }
  if (path.kind !== 'Member' && path.kind !== 'Index') return []
  let object: Value
  try {
    object = evaluate(path.object, moment)
  } catch (error) {
    if (error instanceof Unknown) return []
    throw error
  }
  if (object === null || typeof object !== 'object') return []
  if (path.kind === 'Member') {
    return object.type === 'record' ? [{ kind: 'field', objectId: object.id, key: path.name }] : []
  }
  const key = path.index.kind === 'Number' || path.index.kind === 'String' ? path.index.value : null
  if (object.type === 'record' && typeof key === 'string') {
    return [{ kind: 'field', objectId: object.id, key }]
  }
  if (object.type === 'list' && typeof key === 'number' && Number.isInteger(key)) {
    const index = key < 0 ? key + object.items.length : key
    return index >= 0 ? [{ kind: 'element', objectId: object.id, index }] : []
  }
  return []
}

function changed(
  recording: Recording,
  access: ReplayAccess,
  path: ast.Expr,
  limit: number,
): QueryOutcome {
  const followed = new Map<string, Followed>()
  scan(access, statementStarts(access), (moment) => {
    if (followed.size >= MAX_FOLLOWED) return
    for (const target of placesOf(path, moment)) {
      const key = targetKey(target)
      if (!followed.has(key)) followed.set(key, { target, at: moment.time })
    }
  })
  if (followed.size === 0) {
    return { ok: false, error: 'Nothing by that name was ever visible in this run.' }
  }
  const events = new Map<string, ProvenanceEvent>()
  for (const { target, at } of followed.values()) {
    const live = target.kind === 'local' ? Math.min(at + 1, recording.length) : recording.length
    for (const event of recording.history(target, live, { limit: limit + 1 }).events) {
      if (event.kind === 'alloc') continue
      events.set(`${event.time} ${event.kind} ${targetKey(event.target)}`, event)
    }
  }
  const sorted = [...events.values()].sort((a, b) => a.time - b.time)
  return {
    ok: true,
    result: {
      kind: 'changed',
      events: sorted.slice(0, limit),
      total: sorted.length,
      truncated: sorted.length > limit,
    },
  }
}

// --- calls(name) where … ------------------------------------------------------------------------

function calls(
  recording: Recording,
  access: ReplayAccess,
  name: string,
  where: ast.Expr | null,
  limit: number,
): QueryOutcome {
  const tree = callTree(recording)
  const wanted = [...tree.calls()].filter((call) => call.depth > 0 && call.name === name)
  if (wanted.length === 0) return { ok: false, error: `No function named ${name} was called.` }
  // A call is judged just before its Return runs: its frame is live and the result is on top.
  const visits = wanted
    .map((call) => ({ call, time: call.outcome === 'returned' ? call.exit : call.entry }))
    .sort((a, b) => a.time - b.time)
  const found: QueryCall[] = []
  let total = 0
  const seeker = access.newSeeker()
  for (const { call, time } of visits) {
    const vm = seeker.positionAt(time)
    const returned = call.outcome === 'returned'
    const result = returned ? (vm.stack[vm.stack.length - 1] ?? null) : undefined
    const extra = new Map<string, Value>(result === undefined ? [] : [['ret', result]])
    if (where !== null && !holds(where, { vm, time, table: access.table, extra })) continue
    total += 1
    if (found.length >= limit) continue
    const ending = result === undefined ? 'did not return' : `returned ${text(result)}`
    found.push({ entry: call.entry, exit: call.exit, text: `${name}(${parameters(vm)}) ${ending}` })
  }
  found.sort((a, b) => a.entry - b.entry)
  return {
    ok: true,
    result: { kind: 'calls', calls: found, total, truncated: total > found.length },
  }
}

function text(value: Value): string {
  return preview(value, VALUE_TEXT)
}

/** `n = 4, xs = [1, 2]`: the innermost frame's identifier parameters. */
function parameters(vm: VM): string {
  const frame = vm.frames[vm.frames.length - 1]
  if (frame === undefined) return ''
  const proto = frame.closure.proto
  return proto.debug.locals
    .filter((local) => local.kind === 'param' && !local.hidden && local.slot <= proto.arity)
    .sort((a, b) => a.slot - b.slot)
    .map((local) => `${local.name} = ${text(vm.stack[frame.base + local.slot] ?? null)}`)
    .join(', ')
}
