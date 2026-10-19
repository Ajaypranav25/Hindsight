/**
 * The Hindsight parser (docs/SPEC.md §3, docs/ARCHITECTURE.md §4.2). Recursive descent with no error
 * recovery: the first syntax error is the only diagnostic; otherwise the post-parse checks are
 * returned, sorted. Never throws on user input.
 */
import type { Program } from './ast'
import { compareDiagnostics, diagnostic } from './diagnostics'
import type { Diagnostic } from './diagnostics'
import { lex } from './lexer'
import { SyntaxAbort } from './parser-context'
import { StatementParser } from './parser-statements'
import { span } from './span'

export interface ParseResult {
  readonly program: Program
  readonly diagnostics: Diagnostic[]
}

export function parse(source: string): ParseResult {
  const lexed = lex(source)
  if (lexed.diagnostics.length > 0)
    return { program: emptyProgram(source), diagnostics: lexed.diagnostics }
  const parser = new StatementParser(source, lexed.tokens)
  try {
    const program = parser.parseProgram()
    return { program, diagnostics: sortedUnique(parser.recordedChecks()) }
  } catch (error) {
    if (error instanceof SyntaxAbort)
      return { program: emptyProgram(source), diagnostics: [error.diagnostic] }
    // The nesting limits keep recursion far below the engine's stack limit; this is a last resort
    // so that user input can never surface a raw exception (ARCHITECTURE §2).
    if (error instanceof RangeError) {
      const anchor = span(source.length, source.length)
      return {
        program: emptyProgram(source),
        diagnostics: [diagnostic('E028', 'expression is nested too deeply', anchor)],
      }
    }
    throw error
  }
}

function emptyProgram(source: string): Program {
  return { kind: 'Program', body: [], span: span(0, source.length) }
}

/** Sorted by position; exact duplicates removed (SPEC §11.2). */
function sortedUnique(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const sorted = [...diagnostics].sort(compareDiagnostics)
  return sorted.filter((d, i) => i === 0 || !sameDiagnostic(d, sorted[i - 1]!))
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
