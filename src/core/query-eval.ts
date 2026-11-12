/**
 * Evaluating query expressions against a replay VM (ARCHITECTURE §7.9). A query expression is a
 * Hindsight expression read with the real parser, but it only looks: names resolve in the
 * innermost frame (locals, captured variables, then globals), nothing is called but a few pure
 * functions, nothing is written. A name that is not visible, or an operation that would raise,
 * makes the expression unknown at that moment (`Unknown`), which a predicate counts as false.
 */
import type { WriteTarget } from './api-types'
import type * as ast from './ast'
import { functionDisplayName } from './bytecode'
import type { ProtoTable } from './inspector-location'
import type { Value, VM } from './runtime-types'
import { equals, isTruthy, typeName } from './values'

/** Thrown inside evaluation when the expression has no value at this moment. */
export class Unknown extends Error {}

/** The functions a query may call. */
export const QUERY_FUNCTIONS = ['len', 'type', 'abs', 'has', 'contains'] as const

/** Names every query can read besides the program's variables (a variable of the same name wins). */
export const QUERY_SPECIALS = ['depth', 'step', 'line', 'function'] as const

export interface Resolved {
  readonly value: Value
  readonly target: WriteTarget
}

/** A moment of the replay: the VM about to execute step `time`, and extra names (`ret`). */
export interface Moment {
  readonly vm: VM
  readonly time: number
  readonly table: ProtoTable
  readonly extra?: ReadonlyMap<string, Value>
}

/** The variable `name` as the innermost frame sees it, with where it lives; null if not visible. */
export function resolveName(vm: VM, name: string): Resolved | null {
  const frame = vm.frames[vm.frames.length - 1]
  if (frame !== undefined) {
    const { proto, upvalues } = frame.closure
    let best: { readonly slot: number; readonly startIp: number } | null = null
    for (const local of proto.debug.locals) {
      if (local.name !== name || local.hidden) continue
      if (local.startIp > frame.ip || local.endIp <= frame.ip) continue
      if (frame.base + local.slot >= vm.stack.length) continue
      if (best === null || local.startIp > best.startIp) best = local
    }
    if (best !== null) {
      return {
        value: vm.stack[frame.base + best.slot] ?? null,
        target: { kind: 'local', frameUid: frame.uid, slot: best.slot },
      }
    }
    const cell = upvalues[proto.debug.upvalueNames.indexOf(name)]
    if (cell !== undefined) {
      return cell.open
        ? {
            value: vm.stack[cell.stackIndex] ?? null,
            target: { kind: 'local', frameUid: cell.ownerFrameUid, slot: cell.slot },
          }
        : { value: cell.value, target: { kind: 'cell', cellId: cell.id } }
    }
  }
  const global = vm.globals.get(name)
  if (global === undefined && !vm.globals.has(name)) return null
  return { value: global ?? null, target: { kind: 'global', name } }
}

function special(moment: Moment, name: string): Value | undefined {
  const { vm, table } = moment
  const frame = vm.frames[vm.frames.length - 1]
  switch (name) {
    case 'depth':
      return Math.max(0, vm.frames.length - 1)
    case 'step':
      return moment.time
    case 'line':
      if (frame === undefined) return undefined
      return table.stmtLines(frame.closure.proto)[frame.ip] ?? undefined
    case 'function':
      if (frame === undefined) return undefined
      return frame.closure.proto.kind === 'script'
        ? '<top level>'
        : functionDisplayName(frame.closure.proto)
    default:
      return undefined
  }
}

/** The value of `expr` at `moment`; throws `Unknown` when it has none. */
export function evaluate(expr: ast.Expr, moment: Moment): Value {
  switch (expr.kind) {
    case 'Number':
    case 'String':
    case 'Bool':
      return expr.value
    case 'Nil':
      return null
    case 'Ident': {
      const extra = moment.extra?.get(expr.name)
      if (extra !== undefined) return extra
      const found = resolveName(moment.vm, expr.name)
      if (found !== null) return found.value
      const value = special(moment, expr.name)
      if (value === undefined) throw new Unknown(expr.name)
      return value
    }
    case 'Unary': {
      const operand = evaluate(expr.operand, moment)
      if (expr.op === 'not') return !isTruthy(operand)
      return -number(operand)
    }
    case 'Logical': {
      const left = evaluate(expr.left, moment)
      if (expr.op === 'and') return isTruthy(left) ? evaluate(expr.right, moment) : left
      return isTruthy(left) ? left : evaluate(expr.right, moment)
    }
    case 'Binary':
      return binary(expr, evaluate(expr.left, moment), evaluate(expr.right, moment))
    case 'Member':
      return member(evaluate(expr.object, moment), expr.name)
    case 'Index':
      return index(evaluate(expr.object, moment), evaluate(expr.index, moment))
    case 'Call':
      return call(
        expr,
        expr.args.map((arg) => evaluate(arg, moment)),
      )
    default:
      throw new Unknown(expr.kind)
  }
}

/** Whether `expr` holds at `moment`; null when it has no value there (a name is out of scope). */
export function check(expr: ast.Expr, moment: Moment): boolean | null {
  try {
    return isTruthy(evaluate(expr, moment))
  } catch (error) {
    if (error instanceof Unknown) return null
    throw error
  }
}

/** True when `expr` holds at `moment`; an expression without a value there does not hold. */
export function holds(expr: ast.Expr, moment: Moment): boolean {
  return check(expr, moment) === true
}

function number(value: Value): number {
  if (typeof value !== 'number') throw new Unknown('not a number')
  return value
}

function binary(expr: ast.Binary, left: Value, right: Value): Value {
  switch (expr.op) {
    case '==':
      return equals(left, right)
    case '!=':
      return !equals(left, right)
    case '+':
      if (typeof left === 'string' && typeof right === 'string') return left + right
      return number(left) + number(right)
    case '-':
      return number(left) - number(right)
    case '*':
      return number(left) * number(right)
    case '/':
      return number(left) / number(right)
    case '%': {
      const divisor = number(right)
      // Floored modulo, like the language's (SPEC §7.2).
      return number(left) - divisor * Math.floor(number(left) / divisor)
    }
    case '**':
      return number(left) ** number(right)
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(expr.op, left, right)
    default:
      throw new Unknown(expr.op)
  }
}

function compare(op: '<' | '<=' | '>' | '>=', left: Value, right: Value): boolean {
  const bothNumbers = typeof left === 'number' && typeof right === 'number'
  const bothStrings = typeof left === 'string' && typeof right === 'string'
  if (!bothNumbers && !bothStrings) throw new Unknown('not comparable')
  const a = left as number | string
  const b = right as number | string
  if (op === '<') return a < b
  if (op === '<=') return a <= b
  return op === '>' ? a > b : a >= b
}

function sizeOf(value: Value): number {
  if (typeof value === 'string') return value.length
  if (value !== null && typeof value === 'object') {
    if (value.type === 'list') return value.items.length
    if (value.type === 'record') return value.fields.size
  }
  throw new Unknown('no length')
}

function member(object: Value, name: string): Value {
  if (object !== null && typeof object === 'object' && object.type === 'record') {
    const value = object.fields.get(name)
    if (value !== undefined) return value
  }
  // `xs.len` reads like the question it asks, so it is accepted beside `len(xs)`.
  if (name === 'len' || name === 'length') return sizeOf(object)
  throw new Unknown(name)
}

function index(object: Value, key: Value): Value {
  if (object !== null && typeof object === 'object') {
    if (object.type === 'list' && typeof key === 'number' && Number.isInteger(key)) {
      const value = object.items[key < 0 ? key + object.items.length : key]
      if (value !== undefined) return value
    }
    if (object.type === 'record' && typeof key === 'string') {
      const value = object.fields.get(key)
      if (value !== undefined) return value
    }
  }
  throw new Unknown('no such element')
}

function call(expr: ast.Call, args: readonly Value[]): Value {
  const name = expr.callee.kind === 'Ident' ? expr.callee.name : ''
  const [first = null, second = null] = args
  switch (name) {
    case 'len':
      return sizeOf(first)
    case 'type':
      return typeName(first)
    case 'abs':
      return Math.abs(number(first))
    case 'has':
      if (first === null || typeof first !== 'object' || first.type !== 'record') {
        throw new Unknown('not a record')
      }
      return typeof second === 'string' && first.fields.has(second)
    case 'contains':
      if (typeof first === 'string') return typeof second === 'string' && first.includes(second)
      if (first === null || typeof first !== 'object' || first.type !== 'list') {
        throw new Unknown('not a list')
      }
      return first.items.some((item) => equals(item, second))
    default:
      throw new Unknown(name)
  }
}
