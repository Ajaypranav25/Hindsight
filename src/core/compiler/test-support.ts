/**
 * Test-only helpers for the compiler's tests (kept here because src/core/testing is owned by the
 * VM tests). They throw plain Errors on unexpected input, which is fine in tests.
 */
import type { FunctionProto, Program } from '../bytecode'
import { disassemble } from '../disasm'
import { parse } from '../parser'
import type { Span } from '../span'
import { verifyProgram } from '../verify'
import type { CompileMode, CompileOutput } from './index'
import { compileProgram } from './index'

/** Parses (which must succeed) and compiles `source`. */
export function compileSource(
  source: string,
  mode: CompileMode = 'main',
  firstProtoId = 0,
): CompileOutput {
  const parsed = parse(source)
  if (parsed.diagnostics.length > 0) {
    throw new Error(`parse failed: ${JSON.stringify(parsed.diagnostics)}`)
  }
  return compileProgram(parsed.program, { source, mode, firstProtoId })
}

/** Compiles `source`, requiring no diagnostics and a program that verifies cleanly. */
export function compileOk(source: string, mode: CompileMode = 'main', firstProtoId = 0): Program {
  const output = compileSource(source, mode, firstProtoId)
  if (output.program === null) {
    throw new Error(`compile failed: ${JSON.stringify(output.diagnostics)}`)
  }
  requireVerified(output.program)
  return output.program
}

function requireVerified(program: Program): void {
  const problems = verifyProgram(program)
  if (problems.length > 0) throw new Error(`verify failed:\n${problems.join('\n')}`)
}

/** The disassembly lines of one proto, without its header. */
export function listing(program: Program, protoIndex = 0): string[] {
  const proto: FunctionProto = program.protos[protoIndex]!
  const text = disassemble({ ...program, protos: [proto] })
  return text.split('\n').slice(1)
}

/** The span of the `occurrence`-th (0-based) appearance of `needle` in `source`. */
export function spanOf(source: string, needle: string, occurrence = 0): Span {
  let start = -1
  for (let i = 0; i <= occurrence; i++) {
    start = source.indexOf(needle, start + 1)
    if (start < 0) throw new Error(`'${needle}' #${occurrence} not found`)
  }
  return { start, end: start + needle.length }
}

/** The compile diagnostics of `source` (which must parse); a compiled program must verify. */
export function diagnosticsOf(source: string): CompileOutput['diagnostics'] {
  const output = compileSource(source)
  if (output.program !== null) requireVerified(output.program)
  return output.diagnostics
}

/** Shorthand: compile, verify and list one proto. */
export function codeOf(source: string, protoIndex = 0): string[] {
  return listing(compileOk(source), protoIndex)
}
