/**
 * Pattern checks that run after a pattern is parsed (SPEC §3.6, §6.3): E015 alternatives outside
 * match arms, E017 bindings inside alternatives, E023 duplicate bindings.
 */
import { diagnostic } from './diagnostics'
import type { Diagnostic } from './diagnostics'
import type { Pattern, RestPattern } from './ast'
import { span } from './span'
import type { Span } from './span'

/** A name bound by a pattern. */
export interface Binder {
  readonly name: string
  readonly span: Span
  /** True when the name sits inside an alternative (`p | q`). */
  readonly inAlternative: boolean
}

/** Where a pattern appears: match arms allow alternatives; every other position forbids them. */
export type PatternRole = 'match' | 'binding'

interface PendingPattern {
  readonly pattern: Pattern | RestPattern
  readonly inAlternative: boolean
}

/** Every name a pattern binds, in source order. Iterative, so nesting depth is irrelevant. */
export function patternBinders(root: Pattern): Binder[] {
  const binders: Binder[] = []
  const work: PendingPattern[] = [{ pattern: root, inAlternative: false }]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const { pattern, inAlternative } = item
    const children = childPatterns(pattern)
    for (let i = children.length - 1; i >= 0; i--) {
      work.push({ pattern: children[i]!, inAlternative: inAlternative || pattern.kind === 'POr' })
    }
    const binder = bindingOf(pattern)
    if (binder !== null) binders.push({ ...binder, inAlternative })
  }
  return binders
}

function childPatterns(pattern: Pattern | RestPattern): readonly (Pattern | RestPattern)[] {
  switch (pattern.kind) {
    case 'PList':
      return pattern.rest === null
        ? [...pattern.before, ...pattern.after]
        : [...pattern.before, pattern.rest, ...pattern.after]
    case 'PRecord':
      return pattern.fields.map((field) => field.pattern)
    case 'POr':
      return pattern.alternatives
    default:
      return []
  }
}

function bindingOf(pattern: Pattern | RestPattern): { name: string; span: Span } | null {
  if (pattern.kind === 'PBind') return { name: pattern.name, span: pattern.span }
  if (pattern.kind === 'PRest' && pattern.name !== null) {
    // A rest span runs from `...` to the end of its name.
    const end = pattern.span.end
    return { name: pattern.name, span: span(end - pattern.name.length, end) }
  }
  return null
}

/**
 * E015 (alternatives outside match arms, once per pattern at its first `|`) or E017 (every name
 * bound inside an alternative of a match pattern).
 */
export function alternativeDiagnostics(
  role: PatternRole,
  binders: readonly Binder[],
  firstBar: Span | null,
): Diagnostic[] {
  if (role === 'binding') {
    return firstBar === null
      ? []
      : [diagnostic('E015', "alternatives ('|') are only allowed in match patterns", firstBar)]
  }
  return binders
    .filter((binder) => binder.inAlternative)
    .map((binder) =>
      diagnostic(
        'E017',
        'alternative patterns cannot bind variables',
        binder.span,
        "use '_' instead of a name inside alternatives",
      ),
    )
}

/** E023 at every repeated name (names inside alternatives are already errors and are skipped). */
export function duplicateBindingDiagnostics(binders: readonly Binder[]): Diagnostic[] {
  const seen = new Set<string>()
  const found: Diagnostic[] = []
  for (const binder of binders) {
    if (binder.inAlternative) continue
    if (seen.has(binder.name)) {
      found.push(diagnostic('E023', `duplicate binding '${binder.name}'`, binder.span))
    }
    seen.add(binder.name)
  }
  return found
}
