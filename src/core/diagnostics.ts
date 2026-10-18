import type { Span } from './span'

/** Compile-time error codes. Messages are cataloged in docs/SPEC.md §11.1. */
export type CompileErrorCode =
  | 'E001'
  | 'E002'
  | 'E003'
  | 'E004'
  | 'E005'
  | 'E006'
  | 'E010'
  | 'E011'
  | 'E012'
  | 'E013'
  | 'E014'
  | 'E015'
  | 'E016'
  | 'E017'
  | 'E018'
  | 'E019'
  | 'E020'
  | 'E021'
  | 'E022'
  | 'E023'
  | 'E024'
  | 'E025'
  | 'E026'
  | 'E027'

/** Runtime error codes. Messages are cataloged in docs/SPEC.md §11.2. */
export type RuntimeErrorCode =
  | 'R001'
  | 'R002'
  | 'R004'
  | 'R005'
  | 'R006'
  | 'R007'
  | 'R008'
  | 'R009'
  | 'R010'
  | 'R011'
  | 'R012'
  | 'R013'
  | 'R014'
  | 'R015'
  | 'R016'
  | 'R017'
  | 'R018'
  | 'R019'
  | 'R020'
  | 'R021'
  | 'R022'
  | 'R024'

export type Severity = 'error' | 'warning'

export interface Diagnostic {
  readonly code: CompileErrorCode
  readonly severity: Severity
  readonly message: string
  readonly span: Span
  readonly hint?: string
}

export function diagnostic(
  code: CompileErrorCode,
  message: string,
  span: Span,
  hint?: string,
): Diagnostic {
  return hint === undefined
    ? { code, severity: 'error', message, span }
    : { code, severity: 'error', message, span, hint }
}

/** Orders diagnostics by position, then by code. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return a.span.start - b.span.start || a.span.end - b.span.end || a.code.localeCompare(b.code)
}

/** Thrown for violated internal invariants: always a bug in Hindsight, never in the user program. */
export class InternalError extends Error {
  constructor(message: string) {
    super(`internal error: ${message}`)
    this.name = 'InternalError'
  }
}

/** Optimal-string-alignment (restricted Damerau–Levenshtein) edit distance. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1)
      }
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}

/**
 * The closest candidate to `name` for a "did you mean" hint: distance <= 2 and smaller than
 * `name.length`. Earlier candidates win ties, so callers pass candidates in priority order.
 */
export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    if (candidate === name) continue
    const distance = editDistance(name, candidate)
    if (distance <= 2 && distance < name.length && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** `did you mean 'x'?` for the closest candidate, or undefined. */
export function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  const match = closestName(name, candidates)
  return match === undefined ? undefined : `did you mean '${match}'?`
}
