/**
 * Test helpers for the time-travel engine: compile source (without the library) or assemble text,
 * and record it with test builtins (natives followed by empty library slots).
 */
import type { RecordOptions, Recording } from '../api-types'
import type { Program } from '../bytecode'
import { compileProgram } from '../compiler/index'
import { parse } from '../parser'
import { record } from '../recorder'
import type { RuntimeDeps, VM } from '../runtime-types'
import { createVM } from '../vm'
import { type AssembleOptions, assemble } from './assembler'
import { testBuiltins } from './vm-harness'

/** Parses and compiles `source` in main mode; throws on any diagnostic error. */
export function compileMain(source: string): Program {
  const parsed = parse(source)
  if (parsed.diagnostics.length > 0) {
    throw new Error(`parse failed: ${JSON.stringify(parsed.diagnostics)}`)
  }
  const output = compileProgram(parsed.program, { source, mode: 'main', firstProtoId: 0 })
  if (output.program === null)
    throw new Error(`compile failed: ${JSON.stringify(output.diagnostics)}`)
  return output.program
}

export function testRuntime(): RuntimeDeps {
  return { createVM, builtins: testBuiltins(), libraryProtos: [] }
}

export function recordSource(source: string, options: RecordOptions = {}): Recording {
  return record(compileMain(source), testRuntime(), options)
}

export function recordAsm(text: string, options: RecordOptions & AssembleOptions = {}): Recording {
  return record(assemble(text, options), testRuntime(), options)
}

/** A fresh, unhooked VM for `program` run to `time` (the reference for seek tests). */
export function freshVMAt(program: Program, runtime: RuntimeDeps, time: number, seed?: number): VM {
  const vm = runtime.createVM(program, {
    builtins: runtime.builtins,
    libraryProtos: runtime.libraryProtos,
    seed,
  })
  vm.runUntil(time)
  return vm
}
