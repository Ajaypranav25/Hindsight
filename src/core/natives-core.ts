/**
 * General natives (SPEC §9.2): output, conversion, inspection, `list`, `range`, `assert`, `panic`
 * and `steps`.
 */
import type { NativeContext, Value } from './runtime-types'
import {
  type Args,
  type NativeTable,
  badArgument,
  messageShow,
  numberArg,
  showOrFail,
  tooLarge,
} from './natives-args'
import {
  SIZE_LIMIT,
  articleType,
  collectElements,
  elementCount,
  isIterable,
  isList,
  isRange,
  isRecord,
  isTruthy,
  rangeLength,
  reprWithin,
  typeName,
} from './values'

function print(ctx: NativeContext, args: Args): Value {
  let text = ''
  for (let i = 0; i < args.length; i++) {
    if (i > 0) text += ' '
    text += showOrFail(ctx, args[i] as Value, SIZE_LIMIT - text.length)
  }
  ctx.print(text)
  return null
}

function repr(ctx: NativeContext, args: Args): Value {
  const text = reprWithin(args[0] as Value, SIZE_LIMIT)
  return text === null ? tooLarge(ctx) : text
}

function len(ctx: NativeContext, args: Args): Value {
  const value = args[0] as Value
  if (typeof value === 'string') return value.length
  if (isList(value)) return value.items.length
  if (isRecord(value)) return value.fields.size
  if (isRange(value)) return rangeLength(value)
  return badArgument(ctx, 'len', 'a list, string, record or range', 1, value)
}

function num(ctx: NativeContext, args: Args): Value {
  const value = args[0] as Value
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return badArgument(ctx, 'num', 'a number or string', 1, value)
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isNaN(parsed) ? null : parsed
}

function list(ctx: NativeContext, args: Args): Value {
  const value = args[0] as Value
  if (!isIterable(value)) return ctx.fail('R013', `cannot iterate over ${articleType(value)}`)
  if (elementCount(value) > SIZE_LIMIT) return tooLarge(ctx)
  return ctx.newList(collectElements(value))
}

function range(ctx: NativeContext, args: Args): Value {
  for (let position = 1; position <= args.length; position++)
    numberArg(ctx, 'range', args, position)
  const numbers = args as readonly number[]
  if (numbers.length === 1) return ctx.newRange(0, numbers[0]!, 1, false)
  if (numbers.length === 2) return ctx.newRange(numbers[0]!, numbers[1]!, 1, false)
  const step = numbers[2]!
  if (step === 0) return ctx.fail('R021', 'range step cannot be zero')
  return ctx.newRange(numbers[0]!, numbers[1]!, step, false)
}

function assert(ctx: NativeContext, args: Args): Value {
  if (isTruthy(args[0] as Value)) return null
  if (args.length === 1) return ctx.fail('R018', 'assertion failed')
  return ctx.fail('R018', `assertion failed: ${messageShow(args[1] as Value)}`)
}

export const CORE_NATIVES: NativeTable = {
  print: { min: 0, max: Infinity, fn: print },
  str: { min: 1, max: 1, fn: (ctx, args) => showOrFail(ctx, args[0] as Value) },
  repr: { min: 1, max: 1, fn: repr },
  type: { min: 1, max: 1, fn: (_ctx, args) => typeName(args[0] as Value) },
  len: { min: 1, max: 1, fn: len },
  num: { min: 1, max: 1, fn: num },
  list: { min: 1, max: 1, fn: list },
  range: { min: 1, max: 3, fn: range },
  assert: { min: 1, max: 2, fn: assert },
  panic: { min: 1, max: 1, fn: (ctx, args) => ctx.fail('R017', messageShow(args[0] as Value)) },
  steps: { min: 0, max: 0, fn: (ctx) => ctx.time },
}
