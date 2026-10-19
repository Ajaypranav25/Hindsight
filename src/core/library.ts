/**
 * The library loader (ARCHITECTURE §6.9): compiles the prelude in library mode, runs it once, and
 * returns the builtin table (natives followed by the library closures) with the library protos.
 */
import { LIBRARY_NAMES, NATIVE_COUNT } from './builtin-names'
import type { Program } from './bytecode'
import { compileProgram } from './compiler/index'
import { InternalError } from './diagnostics'
import { createNatives } from './natives'
import { parse } from './parser'
import { PRELUDE_SOURCE } from './prelude'
import type { ClosureObj, Library, Value } from './runtime-types'
import { createVM } from './vm'

/** Generous bound on the prelude's initialization (it only defines functions). */
const PRELUDE_STEP_LIMIT = 100_000

let cached: Library | null = null

/** The library, built on first use and shared afterwards. Throws `InternalError` on a bad prelude. */
export function getLibrary(): Library {
  cached ??= buildLibrary(PRELUDE_SOURCE)
  return cached
}

/** Builds a library from `source` (exported for tests of the failure paths). */
export function buildLibrary(source: string): Library {
  const program = compilePrelude(source)
  const builtins = runPrelude(program)
  return { source, builtins, protos: program.protos }
}

function compilePrelude(source: string): Program {
  const parsed = parse(source)
  if (parsed.diagnostics.length > 0) {
    throw new InternalError(`the prelude does not parse: ${JSON.stringify(parsed.diagnostics)}`)
  }
  const output = compileProgram(parsed.program, { source, mode: 'library', firstProtoId: 0 })
  if (output.program === null) {
    throw new InternalError(`the prelude does not compile: ${JSON.stringify(output.diagnostics)}`)
  }
  return output.program
}

function runPrelude(program: Program): Value[] {
  const builtins: Value[] = [...createNatives(), ...LIBRARY_NAMES.map((): Value => null)]
  const vm = createVM(program, { builtins, libraryProtos: [] })
  vm.runUntil(PRELUDE_STEP_LIMIT)
  if (vm.status === 'error') {
    throw new InternalError(`the prelude failed to run: ${JSON.stringify(vm.error)}`)
  }
  if (vm.status !== 'finished') {
    throw new InternalError(`the prelude did not finish within ${PRELUDE_STEP_LIMIT} steps`)
  }
  return builtins.map((value, index) =>
    index < NATIVE_COUNT ? value : libraryClosure(value, index),
  )
}

/** Library closures get the builtin ids `-(index + 1)` so tools display them as builtins. */
function libraryClosure(value: Value, index: number): ClosureObj {
  const name = LIBRARY_NAMES[index - NATIVE_COUNT]!
  if (value === null || typeof value !== 'object' || value.type !== 'closure') {
    throw new InternalError(`the prelude did not define '${name}'`)
  }
  return { type: 'closure', id: -(index + 1), proto: value.proto, upvalues: value.upvalues }
}
