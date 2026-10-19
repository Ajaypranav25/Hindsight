/**
 * The compiler (ARCHITECTURE §4.3): name resolution (the name stage of SPEC §11.2), code generation
 * and debug info. Never throws on user input; `InternalError` signals a bug (or invalid library
 * source in library mode).
 */
import type { Program as AstProgram } from '../ast'
import { Op } from '../bytecode'
import type { Program } from '../bytecode'
import type { Diagnostic } from '../diagnostics'
import { compareDiagnostics, diagnostic } from '../diagnostics'
import { span } from '../span'
import { CompileContext } from './context'
import type { CompileMode } from './context'
import { FunctionState } from './function-state'
import { collectGlobals, globalInfos } from './globals'
import { compileStmt } from './statements'

export type { CompileMode } from './context'

export interface CompileOptions {
  readonly source: string
  readonly mode: CompileMode
  readonly firstProtoId: number
}

export interface CompileOutput {
  readonly program: Program | null
  readonly diagnostics: Diagnostic[]
}

function sameDiagnostic(a: Diagnostic, b: Diagnostic): boolean {
  return (
    a.code === b.code &&
    a.message === b.message &&
    a.span.start === b.span.start &&
    a.span.end === b.span.end &&
    a.hint === b.hint
  )
}

/** Sorted by position; exact duplicates removed (SPEC §11.2). */
function sortedUnique(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const sorted = [...diagnostics].sort(compareDiagnostics)
  return sorted.filter((d, i) => i === 0 || !sameDiagnostic(d, sorted[i - 1]!))
}

function compileUnchecked(ast: AstProgram, options: CompileOptions): CompileOutput {
  const ctx = new CompileContext(options.source, options.mode, options.firstProtoId)
  collectGlobals(ctx, ast)
  const end = span(options.source.length, options.source.length)
  const script = new FunctionState(ctx, null, {
    name: '<top level>',
    kind: 'script',
    arity: 0,
    span: span(0, options.source.length),
    baseStmtSpan: end,
  })
  for (const stmt of ast.body) compileStmt(script, stmt)
  script.emit(Op.Nil, [], end)
  script.emit(Op.Return, [], end)
  const scriptProto = script.finish()
  const diagnostics = sortedUnique(ctx.diagnostics)
  if (diagnostics.length > 0) return { program: null, diagnostics }
  const program: Program = {
    source: options.source,
    script: scriptProto,
    protos: ctx.protos(),
    firstProtoId: options.firstProtoId,
    globals: globalInfos(ctx),
    diagnostics: [],
  }
  return { program, diagnostics: [] }
}

/** Compiles a parsed program. Returns the program, or null with the name-stage diagnostics. */
export function compileProgram(ast: AstProgram, options: CompileOptions): CompileOutput {
  try {
    return compileUnchecked(ast, options)
  } catch (error) {
    // The parser bounds nesting (E028), so this is a last resort that keeps user input from ever
    // surfacing a raw stack overflow (ARCHITECTURE §2).
    if (error instanceof RangeError) {
      const anchor = span(options.source.length, options.source.length)
      return {
        program: null,
        diagnostics: [diagnostic('E028', 'expression is nested too deeply', anchor)],
      }
    }
    throw error
  }
}
