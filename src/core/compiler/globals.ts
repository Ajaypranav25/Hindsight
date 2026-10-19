/**
 * The global pre-pass (SPEC §5.3–5.4): every declaration directly at top level declares a global,
 * visible to the whole program. A second declaration of a name is E022; the first one wins.
 */
import type { Program, Stmt } from '../ast'
import type { GlobalInfo } from '../bytecode'
import { diagnostic } from '../diagnostics'
import type { CompileContext, GlobalDecl } from './context'
import { patternBindings } from './patterns'

const E022_HINT = "globals can be declared once; use 'var' and assign instead"

function declare(ctx: CompileContext, candidate: GlobalDecl): void {
  const first = ctx.globals.get(candidate.name)
  if (first === undefined) {
    ctx.globals.set(candidate.name, candidate)
    return
  }
  const line = ctx.lineIndex.lineOf(first.declSpan.start)
  const message = `'${candidate.name}' is already declared on line ${line}`
  ctx.report(diagnostic('E022', message, candidate.declSpan, E022_HINT))
}

function declarationsOf(stmt: Stmt): GlobalDecl[] {
  const declEnd = stmt.span.end
  if (stmt.kind === 'FnDecl') {
    return [{ name: stmt.name, kind: 'fn', mutable: false, declSpan: stmt.nameSpan, declEnd }]
  }
  if (stmt.kind !== 'Let') return []
  const kind = stmt.mutable ? 'var' : 'let'
  return patternBindings(stmt.pattern).map((b) => ({
    name: b.name,
    kind,
    mutable: stmt.mutable,
    declSpan: b.span,
    declEnd,
  }))
}

/** Fills `ctx.globals` (main mode only) and reports E022. */
export function collectGlobals(ctx: CompileContext, program: Program): void {
  if (ctx.mode !== 'main') return
  for (const stmt of program.body) {
    for (const decl of declarationsOf(stmt)) declare(ctx, decl)
  }
}

export function globalInfos(ctx: CompileContext): GlobalInfo[] {
  return [...ctx.globals.values()].map((g) => ({
    name: g.name,
    kind: g.kind,
    mutable: g.mutable,
    declSpan: g.declSpan,
  }))
}
