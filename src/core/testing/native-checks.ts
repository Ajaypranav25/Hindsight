/** Assertion helpers for native tests: call a native through the VM's call path. */
import type { Value } from '../runtime-types'
import { repr } from '../values'
import { callNative } from './vm-harness'

/** Calls a native that must succeed and returns its result. */
export function ok(name: string, ...args: Value[]): Value {
  const result = callNative(name, ...args)
  if (!result.ok) throw new Error(`${name} failed: ${result.code} ${result.message}`)
  return result.value
}

/** `repr` of a successful call's result. */
export function shown(name: string, ...args: Value[]): string {
  return repr(ok(name, ...args))
}

/** Calls a native that must fail and returns its error. */
export function err(name: string, ...args: Value[]): { code: string; message: string } {
  const result = callNative(name, ...args)
  if (result.ok) throw new Error(`${name} unexpectedly returned ${repr(result.value)}`)
  return { code: result.code, message: result.message }
}

/** The generic R019 error of SPEC §9.1 rule 6. */
export function r019(
  name: string,
  description: string,
  position: number,
  got: string,
): { code: string; message: string } {
  return {
    code: 'R019',
    message: `'${name}' expects ${description} as argument ${position}, got ${got}`,
  }
}
