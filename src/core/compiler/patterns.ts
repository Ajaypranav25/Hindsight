/**
 * Patterns → `PatternDesc` constants (ARCHITECTURE §4.3.4). Bindings come out in SPEC §6.2 order:
 * depth first, left to right; for lists the items before the rest, the rest, then the items after.
 * Recursion follows the pattern's nesting, which the parser bounds (E028).
 */
import type { Pattern } from '../ast'
import type { PatternConst, PatternDesc } from '../bytecode'
import type { Span } from '../span'

export interface PatternBinding {
  readonly name: string
  readonly span: Span
}

export interface CompiledPattern {
  readonly constant: PatternConst
  readonly bindings: readonly PatternBinding[]
}

function describe(pattern: Pattern, out: PatternBinding[]): PatternDesc {
  switch (pattern.kind) {
    case 'PWildcard':
      return { t: 'any' }
    case 'PBind':
      out.push({ name: pattern.name, span: pattern.span })
      return { t: 'bind' }
    case 'PLiteral':
      return { t: 'lit', value: pattern.value }
    case 'PRange':
      return { t: 'range', start: pattern.start, end: pattern.end, inclusive: pattern.inclusive }
    case 'PList': {
      const before = pattern.before.map((item) => describe(item, out))
      const rest = pattern.rest === null ? 'none' : pattern.rest.name === null ? 'discard' : 'bind'
      if (pattern.rest !== null && pattern.rest.name !== null) {
        // The rest node spans `...name`; the binding is the name at its end.
        const end = pattern.rest.span.end
        out.push({ name: pattern.rest.name, span: { start: end - pattern.rest.name.length, end } })
      }
      const after = pattern.after.map((item) => describe(item, out))
      return { t: 'list', before, rest, after }
    }
    case 'PRecord':
      return {
        t: 'record',
        fields: pattern.fields.map((f) => ({ key: f.key, pattern: describe(f.pattern, out) })),
      }
    case 'POr':
      return { t: 'or', alternatives: pattern.alternatives.map((alt) => describe(alt, out)) }
  }
}

/** The pattern's descriptor, exact source text and bindings in binding order. */
export function compilePattern(pattern: Pattern, source: string): CompiledPattern {
  const bindings: PatternBinding[] = []
  const desc = describe(pattern, bindings)
  const text = source.slice(pattern.span.start, pattern.span.end)
  return { constant: { tag: 'pattern', desc, text, bindCount: bindings.length }, bindings }
}

/** The names a pattern binds, in binding order. */
export function patternBindings(pattern: Pattern): readonly PatternBinding[] {
  const bindings: PatternBinding[] = []
  describe(pattern, bindings)
  return bindings
}
