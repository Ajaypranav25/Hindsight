/**
 * Type tests and classification of runtime values (SPEC §4.1–4.2). Re-exported by values.ts.
 */
import type { TypeName } from './api-types'
import { InternalError } from './diagnostics'
import type {
  ClosureObj,
  HeapObject,
  ListObj,
  NativeObj,
  RangeObj,
  RecordObj,
  Value,
} from './runtime-types'

/** SPEC §10.5: the largest list, record or string any operation may create. */
export const SIZE_LIMIT = 2 ** 24

export function isHeapObject(value: Value): value is HeapObject {
  return typeof value === 'object' && value !== null
}

export function isList(value: Value): value is ListObj {
  return typeof value === 'object' && value !== null && value.type === 'list'
}

export function isRecord(value: Value): value is RecordObj {
  return typeof value === 'object' && value !== null && value.type === 'record'
}

export function isRange(value: Value): value is RangeObj {
  return typeof value === 'object' && value !== null && value.type === 'range'
}

/** User functions, lambdas, library functions and natives. */
export function isCallable(value: Value): value is ClosureObj | NativeObj {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value.type === 'closure' || value.type === 'native')
  )
}

/** Natives and library closures (negative ids) display and inspect as builtins. */
export function isBuiltinValue(value: Value): value is ClosureObj | NativeObj {
  return isCallable(value) && (value.type === 'native' || value.id < 0)
}

/** The `type(v)` name (SPEC §4.1). */
export function typeName(value: Value): TypeName {
  if (value === null) return 'nil'
  switch (typeof value) {
    case 'boolean':
      return 'bool'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    default:
      return heapTypeName(value)
  }
}

function heapTypeName(value: HeapObject): TypeName {
  switch (value.type) {
    case 'list':
      return 'list'
    case 'record':
      return 'record'
    case 'closure':
    case 'native':
      return 'function'
    case 'range':
      return 'range'
    default:
      throw new InternalError(`${value.type} objects are not language values`)
  }
}

/** `nil`, `a bool`, `a number`, … as used in messages (SPEC §4.1). */
export function articleType(value: Value): string {
  const name = typeName(value)
  return name === 'nil' ? 'nil' : `a ${name}`
}

/** SPEC §4.2: only nil and false are falsy. */
export function isTruthy(value: Value): boolean {
  return value !== null && value !== false
}
