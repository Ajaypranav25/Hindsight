/**
 * The native builtins (ARCHITECTURE §6.4, SPEC §9.1–9.2). `createNatives()` returns them in
 * NATIVE_NAMES order: functions as `NativeObj` with ids `-(index + 1)`, `PI` and `INF` as numbers.
 * The VM checks arity (R005) before calling a native; natives check their arguments left to right.
 */
import { NATIVE_NAMES, type NativeName } from './builtin-names'
import { InternalError } from './diagnostics'
import type { NativeSpec, NativeTable } from './natives-args'
import { CORE_NATIVES } from './natives-core'
import { LIST_NATIVES } from './natives-lists'
import { MATH_NATIVES } from './natives-math'
import { RECORD_NATIVES } from './natives-records'
import { STRING_NATIVES } from './natives-strings'
import type { NativeObj, Value } from './runtime-types'

const CONSTANTS: Readonly<Partial<Record<NativeName, number>>> = { PI: Math.PI, INF: Infinity }

const TABLE: NativeTable = {
  ...CORE_NATIVES,
  ...LIST_NATIVES,
  ...RECORD_NATIVES,
  ...STRING_NATIVES,
  ...MATH_NATIVES,
}

export function createNatives(): Value[] {
  return NATIVE_NAMES.map((name, index) => {
    const constant = CONSTANTS[name]
    if (constant !== undefined) return constant
    return nativeObject(name, index, TABLE[name])
  })
}

function nativeObject(name: NativeName, index: number, spec: NativeSpec | undefined): NativeObj {
  if (spec === undefined) throw new InternalError(`native '${name}' is not implemented`)
  return {
    type: 'native',
    id: -(index + 1),
    name,
    minArgs: spec.min,
    maxArgs: spec.max,
    fn: spec.fn,
  }
}
