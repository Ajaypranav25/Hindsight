/**
 * Task and channel natives (SPEC §9.2, §10.6): `spawn`, `channel`, `send`, `recv`, `close`, `wait`,
 * `yield` and `current_task`. They check their arguments and hand the work to the machine through
 * `NativeContext.tasks`, which may block the running task; they never call user code.
 */
import type { ChannelObj, NativeContext, TaskObj, Value } from './runtime-types'
import { type Args, type NativeTable, badArgument } from './natives-args'
import { SIZE_LIMIT } from './values'

function spawn(ctx: NativeContext, args: Args): Value {
  const fn = args[0] as Value
  if (typeof fn === 'object' && fn !== null) {
    if (fn.type === 'closure') return ctx.tasks.spawn(fn, args.slice(1))
    if (fn.type === 'native') {
      return ctx.fail(
        'R019',
        `'spawn' cannot run the builtin '${fn.name}' as a task`,
        `wrap it in a function: spawn(fn() { ${fn.name}(…) })`,
      )
    }
  }
  return badArgument(ctx, 'spawn', 'a function', 1, fn)
}

function channel(ctx: NativeContext, args: Args): Value {
  const capacity = args.length === 0 ? 0 : (args[0] as Value)
  if (
    typeof capacity !== 'number' ||
    !Number.isInteger(capacity) ||
    capacity < 0 ||
    capacity > SIZE_LIMIT
  ) {
    return badArgument(ctx, 'channel', 'a non-negative integer', 1, capacity)
  }
  return ctx.tasks.channel(capacity)
}

function channelArg(ctx: NativeContext, name: string, args: Args): ChannelObj {
  const value = args[0] as Value
  return typeof value === 'object' && value !== null && value.type === 'channel'
    ? value
    : badArgument(ctx, name, 'a channel', 1, value)
}

function taskArg(ctx: NativeContext, name: string, args: Args): TaskObj {
  const value = args[0] as Value
  return typeof value === 'object' && value !== null && value.type === 'task'
    ? value
    : badArgument(ctx, name, 'a task', 1, value)
}

export const TASK_NATIVES: NativeTable = {
  spawn: { min: 1, max: Infinity, fn: spawn },
  channel: { min: 0, max: 1, fn: channel },
  send: {
    min: 2,
    max: 2,
    fn: (ctx, args) => {
      ctx.tasks.send(channelArg(ctx, 'send', args), args[1] as Value)
      return null
    },
  },
  recv: { min: 1, max: 1, fn: (ctx, args) => ctx.tasks.recv(channelArg(ctx, 'recv', args)) },
  close: {
    min: 1,
    max: 1,
    fn: (ctx, args) => {
      ctx.tasks.close(channelArg(ctx, 'close', args))
      return null
    },
  },
  wait: { min: 1, max: 1, fn: (ctx, args) => ctx.tasks.wait(taskArg(ctx, 'wait', args)) },
  yield: {
    min: 0,
    max: 0,
    fn: (ctx) => {
      ctx.tasks.yieldTask()
      return null
    },
  },
  current_task: { min: 0, max: 0, fn: (ctx) => ctx.tasks.current() },
}
