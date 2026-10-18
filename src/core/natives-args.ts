/**
 * Argument checking for natives (SPEC §9.1). Positions are 1-based, as in the messages. Every check
 * fails through `ctx.fail`, so the error is raised at the current call.
 */
import type { NativeName } from './builtin-names'
import type { ListObj, NativeContext, NativeFn, RecordObj, Value } from './runtime-types'
import {
  SIZE_LIMIT,
  articleType,
  isList,
  isRecord,
  preview,
  showWithin,
} from './values'
import { normalizeIndex, type SequenceKind } from './values-index'

export type Args = readonly Value[]

/** A native's arity (`max` is Infinity for variadic natives) and implementation. */
export interface NativeSpec {
  readonly min: number
  readonly max: number
  readonly fn: NativeFn
}

export type NativeTable = Readonly<Partial<Record<NativeName, NativeSpec>>>

/** R019 `'NAME' expects DESCRIPTION as argument N, got AT`. */
export function badArgument(
  ctx: NativeContext,
  name: string,
  description: string,
  position: number,
  value: Value,
): never {
  const message = `'${name}' expects ${description} as argument ${position}, got ${articleType(value)}`
  return ctx.fail('R019', message)
}

/** R025 (SPEC §10.5). */
export function tooLarge(ctx: NativeContext): never {
  return ctx.fail('R025', 'result too large')
}

export function listArg(ctx: NativeContext, name: string, args: Args, position: number): ListObj {
  const value = args[position - 1] as Value
  return isList(value) ? value : badArgument(ctx, name, 'a list', position, value)
}

export function recordArg(ctx: NativeContext, name: string, args: Args, position: number): RecordObj {
  const value = args[position - 1] as Value
  return isRecord(value) ? value : badArgument(ctx, name, 'a record', position, value)
}

export function stringArg(ctx: NativeContext, name: string, args: Args, position: number): string {
  const value = args[position - 1] as Value
  return typeof value === 'string' ? value : badArgument(ctx, name, 'a string', position, value)
}

export function numberArg(ctx: NativeContext, name: string, args: Args, position: number): number {
  const value = args[position - 1] as Value
  return typeof value === 'number' ? value : badArgument(ctx, name, 'a number', position, value)
}

export function integerArg(ctx: NativeContext, name: string, args: Args, position: number): number {
  const value = args[position - 1] as Value
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : badArgument(ctx, name, 'an integer', position, value)
}

/** An index argument (rule 4): like `xs[i]`, R008 for non-integers and R007 when out of range. */
export function indexArg(
  ctx: NativeContext,
  value: Value,
  length: number,
  kind: SequenceKind,
  allowEnd: boolean,
): number {
  const result = normalizeIndex(value, length, kind, allowEnd)
  return typeof result === 'number' ? result : ctx.fail(result.code, result.message)
}

/** `show(value)` for messages: exact up to SIZE_LIMIT code units, cut with an ellipsis beyond. */
export function messageShow(value: Value): string {
  if (typeof value !== 'string') return preview(value, SIZE_LIMIT)
  return value.length <= SIZE_LIMIT ? value : value.slice(0, SIZE_LIMIT - 1) + '…'
}

/** `show(value)`, raising R025 when it is longer than `budget` code units. */
export function showOrFail(ctx: NativeContext, value: Value, budget = SIZE_LIMIT): string {
  const text = showWithin(value, budget)
  return text === null ? tooLarge(ctx) : text
}
