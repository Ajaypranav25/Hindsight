/** Record natives (SPEC §9.2): keys, values, entries, has, get, delete. */
import type { NativeContext, Value } from './runtime-types'
import { type Args, type NativeTable, recordArg, stringArg } from './natives-args'

function entries(ctx: NativeContext, args: Args): Value {
  const fields = recordArg(ctx, 'entries', args, 1).fields
  const pairs: Value[] = []
  for (const [key, value] of fields) pairs.push(ctx.newList([key, value]))
  return ctx.newList(pairs)
}

function get(ctx: NativeContext, args: Args): Value {
  const record = recordArg(ctx, 'get', args, 1)
  const key = stringArg(ctx, 'get', args, 2)
  const value = record.fields.get(key)
  if (value !== undefined) return value
  return args.length > 2 ? (args[2] as Value) : null
}

export const RECORD_NATIVES: NativeTable = {
  keys: {
    min: 1,
    max: 1,
    fn: (ctx, args) => ctx.newList(Array.from(recordArg(ctx, 'keys', args, 1).fields.keys())),
  },
  values: {
    min: 1,
    max: 1,
    fn: (ctx, args) => ctx.newList(Array.from(recordArg(ctx, 'values', args, 1).fields.values())),
  },
  entries: { min: 1, max: 1, fn: entries },
  has: {
    min: 2,
    max: 2,
    fn: (ctx, args) => recordArg(ctx, 'has', args, 1).fields.has(stringArg(ctx, 'has', args, 2)),
  },
  get: { min: 2, max: 3, fn: get },
  delete: {
    min: 2,
    max: 2,
    fn: (ctx, args) => {
      const record = recordArg(ctx, 'delete', args, 1)
      return ctx.recordDelete(record, stringArg(ctx, 'delete', args, 2))
    },
  },
}
