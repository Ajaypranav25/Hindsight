/** A diagnostic or runtime error reduced to what annotations can match (ARCHITECTURE §10.2). */
import type { ErrorAnnotation } from './annotations'

export interface ReportedError {
  readonly code: string
  readonly message: string
  readonly hint?: string | undefined
  /** 1-based line of the span start. */
  readonly line: number
}

/** Same line; same code if given; the message contains TEXT; the hint contains HINT if given. */
export function matchesAnnotation(annotation: ErrorAnnotation, reported: ReportedError): boolean {
  if (annotation.line !== reported.line) return false
  if (annotation.code !== null && annotation.code !== reported.code) return false
  if (annotation.text !== null && !reported.message.includes(annotation.text)) return false
  if (annotation.hint === null) return true
  return reported.hint !== undefined && reported.hint.includes(annotation.hint)
}

export function describeReported(reported: ReportedError): string {
  const hint = reported.hint === undefined ? '' : ` (hint: ${reported.hint})`
  return `line ${reported.line}: ${reported.code} ${reported.message}${hint}`
}
