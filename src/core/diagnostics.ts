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
  | 'E028'

/** Runtime error codes. Messages are cataloged in docs/SPEC.md §11.3. */
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
  | 'R025'

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

/** The largest edit distance a "did you mean" hint accepts (SPEC §5.3). */
const MAX_HINT_DISTANCE = 2

/** Stands for "more than the limit" in the banded table; far above any real distance compared. */
const FAR = 0x3fffffff

/** Scratch rows for `editDistanceWithin`, grown on demand and reused across calls. */
let rowTwoBack = new Int32Array(32)
let rowBack = new Int32Array(32)
let rowNow = new Int32Array(32)

function ensureRows(length: number): void {
  if (rowNow.length >= length) return
  const size = Math.max(length, rowNow.length * 2)
  rowTwoBack = new Int32Array(size)
  rowBack = new Int32Array(size)
  rowNow = new Int32Array(size)
}

/**
 * The optimal-string-alignment (restricted Damerau–Levenshtein) distance between `a` and `b` when it
 * is at most `limit`, otherwise `limit + 1`. Only the diagonal band of width `limit` is computed, and
 * the scan stops as soon as a whole row exceeds `limit` (no later cell can come back under it).
 */
export function editDistanceWithin(a: string, b: string, limit: number): number {
  const n = a.length
  const m = b.length
  const over = limit + 1
  if (limit < 0 || Math.abs(n - m) > limit) return over
  if (n === 0 || m === 0) return Math.max(n, m)
  ensureRows(m + 2)
  let twoBack = rowTwoBack
  let back = rowBack
  let now = rowNow
  for (let j = 0; j <= m + 1; j++) back[j] = j <= limit ? j : FAR
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - limit)
    const hi = Math.min(m, i + limit)
    now[lo - 1] = lo === 1 && i <= limit ? i : FAR
    let rowMin = now[lo - 1]!
    const ai = a.charCodeAt(i - 1)
    for (let j = lo; j <= hi; j++) {
      const bj = b.charCodeAt(j - 1)
      let best = back[j - 1]! + (ai === bj ? 0 : 1)
      const deletion = back[j]! + 1
      if (deletion < best) best = deletion
      const insertion = now[j - 1]! + 1
      if (insertion < best) best = insertion
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        const transposition = twoBack[j - 2]! + 1
        if (transposition < best) best = transposition
      }
      now[j] = best
      if (best < rowMin) rowMin = best
    }
    if (hi < m) now[hi + 1] = FAR
    if (rowMin > limit) return over
    const spare = twoBack
    twoBack = back
    back = now
    now = spare
  }
  const distance = back[m]!
  return distance > limit ? over : distance
}

/**
 * The closest candidate to `name` for a "did you mean" hint: distance <= 2 and smaller than
 * `name.length`. Earlier candidates win ties, so callers pass candidates in priority order.
 * Compiler-internal names (starting with `$`) are never suggested. Each candidate is only measured
 * up to the distance that could still beat the best so far, and skipped outright when the length
 * difference alone rules it out.
 */
export function closestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let cutoff = Math.min(MAX_HINT_DISTANCE, name.length - 1)
  for (const candidate of candidates) {
    // Distance 0 means the same name, which is never suggested: nothing can be accepted any more.
    if (cutoff < 1) break
    if (Math.abs(candidate.length - name.length) > cutoff) continue
    if (candidate === name || candidate.startsWith('$')) continue
    const distance = editDistanceWithin(name, candidate, cutoff)
    if (distance <= cutoff) {
      best = candidate
      cutoff = distance - 1
    }
  }
  return best
}

/** `did you mean 'x'?` for the closest candidate, or undefined. */
export function didYouMean(name: string, candidates: Iterable<string>): string | undefined {
  const match = closestName(name, candidates)
  return match === undefined ? undefined : `did you mean '${match}'?`
}
