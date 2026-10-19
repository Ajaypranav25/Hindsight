/**
 * Name resolution (SPEC §5.3, §5.5): locals, captured locals of enclosing functions (clox-style
 * upvalues), globals, builtins; E020, E021 and E026.
 */
import { Op } from '../bytecode'
import { BUILTIN_NAMES, builtinIndex } from '../builtin-names'
import { diagnostic, didYouMean } from '../diagnostics'
import type { Span } from '../span'
import type { GlobalDecl } from './context'
import type { Binding, FunctionState } from './function-state'

export type Resolution =
  | { readonly kind: 'local'; readonly binding: Binding }
  | { readonly kind: 'upvalue'; readonly index: number; readonly binding: Binding }
  | { readonly kind: 'global'; readonly decl: GlobalDecl }
  | { readonly kind: 'builtin'; readonly index: number }
  | { readonly kind: 'unknown' }

/** The visible local named `name`: innermost scope first, most recent declaration first. */
function findLocal(fs: FunctionState, name: string): Binding | undefined {
  for (let s = fs.scopes.length - 1; s >= 0; s--) {
    const bindings = fs.scopes[s]!.bindings
    for (let i = bindings.length - 1; i >= 0; i--) {
      if (bindings[i]!.name === name) return bindings[i]
    }
  }
  return undefined
}

function findUpvalue(
  fs: FunctionState,
  name: string,
): { index: number; binding: Binding } | undefined {
  const enclosing = fs.enclosing
  if (enclosing === null) return undefined
  const local = findLocal(enclosing, name)
  if (local !== undefined) return { index: fs.addUpvalue(true, local.slot, local), binding: local }
  const outer = findUpvalue(enclosing, name)
  if (outer === undefined) return undefined
  return { index: fs.addUpvalue(false, outer.index, outer.binding), binding: outer.binding }
}

/** Visible locals (innermost first), then globals, then builtins: the hint priority of §5.3. */
function* suggestionCandidates(fs: FunctionState): Generator<string> {
  for (let f: FunctionState | null = fs; f !== null; f = f.enclosing) {
    for (let s = f.scopes.length - 1; s >= 0; s--) {
      const bindings = f.scopes[s]!.bindings
      for (let i = bindings.length - 1; i >= 0; i--) yield bindings[i]!.name
    }
  }
  yield* fs.ctx.globals.keys()
  yield* BUILTIN_NAMES
}

function lookup(fs: FunctionState, name: string): Resolution {
  const local = findLocal(fs, name)
  if (local !== undefined) return { kind: 'local', binding: local }
  const upvalue = findUpvalue(fs, name)
  if (upvalue !== undefined) return { kind: 'upvalue', ...upvalue }
  const decl = fs.ctx.globals.get(name)
  if (decl !== undefined) return { kind: 'global', decl }
  const index = builtinIndex(name)
  if (index >= 0) return { kind: 'builtin', index }
  return { kind: 'unknown' }
}

/**
 * Resolves a reference (a read or an assignment target), reporting E020 for unknown names and
 * E026 for globals used in top-level code before their first declaration ends.
 */
export function resolveReference(fs: FunctionState, name: string, span: Span): Resolution {
  const resolution = lookup(fs, name)
  if (resolution.kind === 'unknown') {
    const hint = didYouMean(name, suggestionCandidates(fs))
    fs.ctx.report(diagnostic('E020', `undefined variable '${name}'`, span, hint))
  } else if (resolution.kind === 'global' && fs.isScript && span.start < resolution.decl.declEnd) {
    const hint =
      builtinIndex(name) >= 0 ? `this declaration hides the builtin '${name}'` : undefined
    fs.ctx.report(diagnostic('E026', `'${name}' is used before it is declared`, span, hint))
  }
  return resolution
}

const KIND_REASONS: Readonly<Record<string, string>> = {
  fn: 'it is a function',
  param: 'it is a parameter',
  loop: 'it is a loop variable',
  match: 'it is a match binding',
}

function reportImmutable(fs: FunctionState, name: string, kind: string, span: Span): void {
  if (kind === 'let') {
    const message = `cannot assign to '${name}' because it was declared with 'let'`
    fs.ctx.report(diagnostic('E021', message, span, "declare it with 'var' to make it mutable"))
    return
  }
  const reason = KIND_REASONS[kind] ?? 'it is not mutable'
  fs.ctx.report(diagnostic('E021', `cannot assign to '${name}' because ${reason}`, span))
}

/** Reports E021 when the resolved variable is not a `var` binding. */
export function checkAssignable(
  fs: FunctionState,
  resolution: Resolution,
  name: string,
  span: Span,
): void {
  switch (resolution.kind) {
    case 'local':
    case 'upvalue':
      if (!resolution.binding.mutable) reportImmutable(fs, name, resolution.binding.kind, span)
      return
    case 'global':
      if (!resolution.decl.mutable) reportImmutable(fs, name, resolution.decl.kind, span)
      return
    case 'builtin':
      fs.ctx.report(diagnostic('E021', `cannot assign to builtin '${name}'`, span))
      return
    case 'unknown':
      return
  }
}

export function emitGet(fs: FunctionState, resolution: Resolution, name: string, span: Span): void {
  switch (resolution.kind) {
    case 'local':
      fs.emit(Op.GetLocal, [resolution.binding.slot], span)
      return
    case 'upvalue':
      fs.emit(Op.GetUpvalue, [resolution.index], span)
      return
    case 'global':
      fs.emit(Op.GetGlobal, [fs.constantFor(name)], span)
      return
    case 'builtin':
      fs.emit(Op.GetBuiltin, [resolution.index], span)
      return
    case 'unknown':
      // Only reached with a diagnostic reported; keeps the depth bookkeeping consistent.
      fs.emit(Op.Nil, [], span)
      return
  }
}

export function emitSet(fs: FunctionState, resolution: Resolution, name: string, span: Span): void {
  switch (resolution.kind) {
    case 'local':
      fs.emit(Op.SetLocal, [resolution.binding.slot], span)
      return
    case 'upvalue':
      fs.emit(Op.SetUpvalue, [resolution.index], span)
      return
    case 'global':
      fs.emit(Op.SetGlobal, [fs.constantFor(name)], span)
      return
    default:
      // A builtin or unknown target has already been reported; drop the value.
      fs.emit(Op.Pop, [], span)
      return
  }
}
