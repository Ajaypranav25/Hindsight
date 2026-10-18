/**
 * Arithmetic, comparison and range operators (SPEC §7.2, §7.3, §7.6). The step loop handles the
 * number–number fast paths inline and calls these for everything else.
 */
import type { RangeObj, Value } from './runtime-types'
import { SIZE_LIMIT, isList, typeName } from './values'
import { raise, raiseTooLarge } from './vm-errors'
import type { MachineState } from './vm-state'

export const STRING_NUMBER_HINT = 'convert with str() or use interpolation, e.g. "{x}"'

export type ComparisonOp = '<' | '<=' | '>' | '>='

/** R001 for a binary operator, with the string + number hint for `+`. */
export function binaryOperandError(op: string, a: Value, b: Value): never {
  const left = typeName(a)
  const right = typeName(b)
  const mixesStringAndNumber =
    (left === 'string' && right === 'number') || (left === 'number' && right === 'string')
  const hint = op === '+' && mixesStringAndNumber ? STRING_NUMBER_HINT : undefined
  return raise('R001', `cannot apply '${op}' to ${left} and ${right}`, hint)
}

/** `+` for everything but two numbers: strings, lists, or R001. */
export function addSlow(m: MachineState, a: Value, b: Value): Value {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length + b.length > SIZE_LIMIT) raiseTooLarge()
    return a + b
  }
  if (isList(a) && isList(b)) {
    if (a.items.length + b.items.length > SIZE_LIMIT) raiseTooLarge()
    return m.newList(a.items.concat(b.items))
  }
  return binaryOperandError('+', a, b)
}

/** `/` when the fast path did not apply: R001, or R002 for a zero divisor. */
export function divideSlow(a: Value, b: Value): number {
  if (typeof a !== 'number' || typeof b !== 'number') return binaryOperandError('/', a, b)
  if (b === 0) raise('R002', 'division by zero')
  return a / b
}

/** `%`: the result takes the divisor's sign (SPEC §7.2). */
export function modulo(a: Value, b: Value): number {
  if (typeof a !== 'number' || typeof b !== 'number') return binaryOperandError('%', a, b)
  if (b === 0) raise('R002', 'division by zero')
  const r = a % b
  return r !== 0 && r < 0 !== b < 0 ? r + b : r
}

/** `<`, `<=`, `>`, `>=` for anything but two numbers: two strings, or R001. */
export function compareSlow(op: ComparisonOp, a: Value, b: Value): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return binaryOperandError(op, a, b)
  switch (op) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
  }
}

export function negateSlow(a: Value): never {
  return raise('R001', `cannot apply '-' to ${typeName(a)}`)
}

/** `a..b` / `a..=b`. */
export function makeRange(m: MachineState, a: Value, b: Value, inclusive: boolean): RangeObj {
  if (typeof a !== 'number' || typeof b !== 'number') {
    return binaryOperandError(inclusive ? '..=' : '..', a, b)
  }
  return m.newRange(a, b, 1, inclusive)
}
