/**
 * List and sequence natives (SPEC §9.2): push, pop, insert, remove, slice, reverse, sort, contains,
 * index_of, join, min, max, copy.
 */
import type { ListObj, NativeContext, NativeFn, Value } from './runtime-types'
import {
  type Args,
  type NativeTable,
  badArgument,
  fresh,
  indexArg,
  listArg,
  numberArg,
  showOrFail,
  stringArg,
  tooLarge,
} from './natives-args'
import { SIZE_LIMIT, articleType, equals, isList, isRange, isRecord, rangeContains } from './values'

function push(ctx: NativeContext, args: Args): Value {
  const target = listArg(ctx, 'push', args, 1)
  if (target.items.length >= SIZE_LIMIT) return tooLarge(ctx)
  ctx.listAppend(target, args[1] as Value)
  return null
}

function pop(ctx: NativeContext, args: Args): Value {
  const target = listArg(ctx, 'pop', args, 1)
  if (target.items.length === 0) return ctx.fail('R020', 'cannot pop from an empty list')
  return ctx.listPop(target)
}

function insert(ctx: NativeContext, args: Args): Value {
  const target = listArg(ctx, 'insert', args, 1)
  const index = indexArg(ctx, args[1] as Value, target.items.length, 'list', true)
  if (target.items.length >= SIZE_LIMIT) return tooLarge(ctx)
  ctx.listInsert(target, index, args[2] as Value)
  return null
}

function remove(ctx: NativeContext, args: Args): Value {
  const target = listArg(ctx, 'remove', args, 1)
  const index = indexArg(ctx, args[1] as Value, target.items.length, 'list', false)
  return ctx.listRemove(target, index)
}

function sequenceArg(ctx: NativeContext, name: string, args: Args): ListObj | string {
  const value = args[0] as Value
  return typeof value === 'string' || isList(value)
    ? value
    : badArgument(ctx, name, 'a list or string', 1, value)
}

function slice(ctx: NativeContext, args: Args): Value {
  const sequence = sequenceArg(ctx, 'slice', args)
  const start = numberArg(ctx, 'slice', args, 2)
  const end = args.length > 2 ? numberArg(ctx, 'slice', args, 3) : undefined
  if (typeof sequence === 'string') return fresh(ctx, sequence.slice(start, end))
  return ctx.newList(sequence.items.slice(start, end))
}

function reverse(ctx: NativeContext, args: Args): Value {
  const sequence = sequenceArg(ctx, 'reverse', args)
  if (typeof sequence === 'string') return fresh(ctx, sequence.split('').reverse().join(''))
  return ctx.newList(sequence.items.slice().reverse())
}

/** Ascending by `<` (numbers numerically, strings by UTF-16 code units). */
function compareAscending(a: Value, b: Value): number {
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
}

function sort(ctx: NativeContext, args: Args): Value {
  const target = listArg(ctx, 'sort', args, 1)
  const items = target.items
  const kind = items.length === 0 ? 'number' : typeof items[0]
  const uniform = (kind === 'number' || kind === 'string') && items.every((x) => typeof x === kind)
  if (!uniform) {
    return ctx.fail('R019', "'sort' can only sort a list of all numbers or all strings")
  }
  // Array.prototype.sort is stable (ES2019).
  return ctx.newList(items.slice().sort(compareAscending))
}

function contains(ctx: NativeContext, args: Args): Value {
  const container = args[0] as Value
  const needle = args[1] as Value
  if (typeof container === 'string') return container.includes(stringArg(ctx, 'contains', args, 2))
  if (isList(container)) return container.items.some((item) => equals(item, needle))
  if (isRecord(container)) return typeof needle === 'string' && container.fields.has(needle)
  if (isRange(container)) return rangeContains(container, needle)
  return badArgument(ctx, 'contains', 'a list, string, record or range', 1, container)
}

function indexOf(ctx: NativeContext, args: Args): Value {
  const sequence = sequenceArg(ctx, 'index_of', args)
  if (typeof sequence === 'string') return sequence.indexOf(stringArg(ctx, 'index_of', args, 2))
  const needle = args[1] as Value
  return sequence.items.findIndex((item) => equals(item, needle))
}

function join(ctx: NativeContext, args: Args): Value {
  const items = listArg(ctx, 'join', args, 1).items
  const separator = args.length > 1 ? stringArg(ctx, 'join', args, 2) : ''
  let text = ''
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      if (text.length + separator.length > SIZE_LIMIT) return tooLarge(ctx)
      text += separator
    }
    text += showOrFail(ctx, items[i] as Value, SIZE_LIMIT - text.length)
  }
  // The pieces were charged by showOrFail; the separators are charged here.
  ctx.charge(Math.max(0, items.length - 1) * separator.length)
  return text
}

/** `min`/`max`: one list argument (its items) or numbers (SPEC §9.2). */
function extremum(name: 'min' | 'max', pick: (a: number, b: number) => number): NativeFn {
  return (ctx, args) => {
    const first = args[0] as Value
    if (args.length === 1 && isList(first)) return listExtremum(ctx, name, first, pick)
    let result = name === 'min' ? Infinity : -Infinity
    for (let position = 1; position <= args.length; position++) {
      result = pick(result, numberArg(ctx, name, args, position))
    }
    return result
  }
}

function listExtremum(
  ctx: NativeContext,
  name: string,
  target: ListObj,
  pick: (a: number, b: number) => number,
): Value {
  const items = target.items
  if (items.length === 0) return ctx.fail('R019', `'${name}' expects a non-empty list`)
  let result = name === 'min' ? Infinity : -Infinity
  for (const item of items) {
    if (typeof item !== 'number') {
      return ctx.fail(
        'R019',
        `'${name}' expects a list of numbers as argument 1, got ${articleType(item)}`,
      )
    }
    result = pick(result, item)
  }
  return result
}

function copy(ctx: NativeContext, args: Args): Value {
  const value = args[0] as Value
  if (isList(value)) return ctx.newList(value.items.slice())
  if (isRecord(value)) return ctx.newRecord(new Map(value.fields))
  return badArgument(ctx, 'copy', 'a list or record', 1, value)
}

export const LIST_NATIVES: NativeTable = {
  push: { min: 2, max: 2, fn: push },
  pop: { min: 1, max: 1, fn: pop },
  insert: { min: 3, max: 3, fn: insert },
  remove: { min: 2, max: 2, fn: remove },
  slice: { min: 2, max: 3, fn: slice },
  reverse: { min: 1, max: 1, fn: reverse },
  sort: { min: 1, max: 1, fn: sort },
  contains: { min: 2, max: 2, fn: contains },
  index_of: { min: 2, max: 2, fn: indexOf },
  join: { min: 1, max: 2, fn: join },
  min: { min: 1, max: Infinity, fn: extremum('min', Math.min) },
  max: { min: 1, max: Infinity, fn: extremum('max', Math.max) },
  copy: { min: 1, max: 1, fn: copy },
}
