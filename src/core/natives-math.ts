/**
 * Numeric natives (SPEC §9.2): abs … log, round, atan2, and the generator (random, random_int,
 * seed; SPEC §10.3).
 */
import type { NativeFn, Value } from './runtime-types'
import { type NativeSpec, type NativeTable, integerArg, numberArg } from './natives-args'

function unary(name: string, fn: (x: number) => number): NativeSpec {
  return { min: 1, max: 1, fn: (ctx, args) => fn(numberArg(ctx, name, args, 1)) }
}

/** Nearest integer, halves away from zero. */
export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

const randomInt: NativeFn = (ctx, args) => {
  const lo = integerArg(ctx, 'random_int', args, 1)
  const hi = integerArg(ctx, 'random_int', args, 2)
  if (lo > hi) return ctx.fail('R019', "'random_int' expects lo <= hi")
  return lo + Math.floor(ctx.random() * (hi - lo + 1))
}

const seed: NativeFn = (ctx, args): Value => {
  ctx.seed(numberArg(ctx, 'seed', args, 1))
  return null
}

export const MATH_NATIVES: NativeTable = {
  abs: unary('abs', Math.abs),
  floor: unary('floor', Math.floor),
  ceil: unary('ceil', Math.ceil),
  sqrt: unary('sqrt', Math.sqrt),
  sin: unary('sin', Math.sin),
  cos: unary('cos', Math.cos),
  log: unary('log', Math.log),
  round: unary('round', roundHalfAwayFromZero),
  atan2: {
    min: 2,
    max: 2,
    fn: (ctx, args) => Math.atan2(numberArg(ctx, 'atan2', args, 1), numberArg(ctx, 'atan2', args, 2)),
  },
  random: { min: 0, max: 0, fn: (ctx) => ctx.random() },
  random_int: { min: 2, max: 2, fn: randomInt },
  seed: { min: 1, max: 1, fn: seed },
}
