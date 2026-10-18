/**
 * String natives (SPEC §9.2): upper, lower, trim, split, replace, starts_with, ends_with, repeat,
 * chars, char_code, from_char_code, pad_start, pad_end. All follow the named JavaScript methods.
 */
import type { NativeContext, NativeFn, Value } from './runtime-types'
import {
  type Args,
  type NativeTable,
  badArgument,
  indexArg,
  numberArg,
  stringArg,
  tooLarge,
} from './natives-args'
import { SIZE_LIMIT } from './values'

const MAX_SAFE_LENGTH = Number.MAX_SAFE_INTEGER

function stringMethod(name: string, method: (s: string) => string): NativeFn {
  return (ctx, args) => method(stringArg(ctx, name, args, 1))
}

/** Number of pieces `s.split(separator)` produces, counted without building them. */
function pieceCount(s: string, separator: string): number {
  if (separator === '') return s.length
  let count = 1
  for (let at = s.indexOf(separator); at !== -1; at = s.indexOf(separator, at + separator.length)) {
    count++
  }
  return count
}

function split(ctx: NativeContext, args: Args): Value {
  const s = stringArg(ctx, 'split', args, 1)
  const separator = stringArg(ctx, 'split', args, 2)
  // Fewer than SIZE_LIMIT code units can never produce more than SIZE_LIMIT pieces.
  if (s.length >= SIZE_LIMIT && pieceCount(s, separator) > SIZE_LIMIT) return tooLarge(ctx)
  return ctx.newList(s.split(separator))
}

function replace(ctx: NativeContext, args: Args): Value {
  const s = stringArg(ctx, 'replace', args, 1)
  const from = stringArg(ctx, 'replace', args, 2)
  const to = stringArg(ctx, 'replace', args, 3)
  const pieces = s.split(from)
  let length = Math.max(0, pieces.length - 1) * to.length
  for (const piece of pieces) length += piece.length
  if (length > SIZE_LIMIT) return tooLarge(ctx)
  return pieces.join(to)
}

function repeat(ctx: NativeContext, args: Args): Value {
  const s = stringArg(ctx, 'repeat', args, 1)
  const count = args[1] as Value
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    return badArgument(ctx, 'repeat', 'a non-negative integer', 2, count)
  }
  if (s.length === 0) return ''
  if (s.length * count > SIZE_LIMIT) return tooLarge(ctx)
  return s.repeat(count)
}

function chars(ctx: NativeContext, args: Args): Value {
  const s = stringArg(ctx, 'chars', args, 1)
  if (s.length > SIZE_LIMIT) return tooLarge(ctx)
  return ctx.newList(s.split(''))
}

function charCode(ctx: NativeContext, args: Args): Value {
  const s = stringArg(ctx, 'char_code', args, 1)
  const index = indexArg(ctx, args.length > 1 ? (args[1] as Value) : 0, s.length, 'string', false)
  return s.charCodeAt(index)
}

function fromCharCode(ctx: NativeContext, args: Args): Value {
  const code = args[0] as Value
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0xffff) {
    return badArgument(ctx, 'from_char_code', 'an integer from 0 to 65535', 1, code)
  }
  return String.fromCharCode(code)
}

/** JavaScript ToLength: the target length `padStart`/`padEnd` use. */
function toLength(width: number): number {
  if (Number.isNaN(width) || width <= 0) return 0
  return Math.min(Math.trunc(width), MAX_SAFE_LENGTH)
}

function pad(name: 'pad_start' | 'pad_end'): NativeFn {
  return (ctx, args) => {
    const s = stringArg(ctx, name, args, 1)
    const width = numberArg(ctx, name, args, 2)
    const fill = args.length > 2 ? stringArg(ctx, name, args, 3) : ' '
    const target = toLength(width)
    if (target > s.length && fill !== '' && target > SIZE_LIMIT) return tooLarge(ctx)
    return name === 'pad_start' ? s.padStart(target, fill) : s.padEnd(target, fill)
  }
}

function affix(name: 'starts_with' | 'ends_with'): NativeFn {
  return (ctx, args) => {
    const s = stringArg(ctx, name, args, 1)
    const part = stringArg(ctx, name, args, 2)
    return name === 'starts_with' ? s.startsWith(part) : s.endsWith(part)
  }
}

export const STRING_NATIVES: NativeTable = {
  upper: { min: 1, max: 1, fn: stringMethod('upper', (s) => s.toUpperCase()) },
  lower: { min: 1, max: 1, fn: stringMethod('lower', (s) => s.toLowerCase()) },
  trim: { min: 1, max: 1, fn: stringMethod('trim', (s) => s.trim()) },
  split: { min: 2, max: 2, fn: split },
  replace: { min: 3, max: 3, fn: replace },
  starts_with: { min: 2, max: 2, fn: affix('starts_with') },
  ends_with: { min: 2, max: 2, fn: affix('ends_with') },
  repeat: { min: 2, max: 2, fn: repeat },
  chars: { min: 1, max: 1, fn: chars },
  char_code: { min: 1, max: 2, fn: charCode },
  from_char_code: { min: 1, max: 1, fn: fromCharCode },
  pad_start: { min: 2, max: 3, fn: pad('pad_start') },
  pad_end: { min: 2, max: 3, fn: pad('pad_end') },
}
