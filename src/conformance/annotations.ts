/**
 * Corpus annotations (docs/ARCHITECTURE.md §10.2). Annotations are found by scanning raw physical
 * lines without regard to lexical context, so they also work inside unterminated strings and
 * comments.
 */
import { LineIndex } from '../core/span'

/** `// expect: TEXT`: one expected output line. */
export interface OutputAnnotation {
  readonly kind: 'output'
  /** 1-based line of the annotation. */
  readonly line: number
  /** The expected line, trailing whitespace removed; '' for a bare `// expect:`. */
  readonly text: string
}

/** `// expect compile error[ CODE][: TEXT][ // hint: HINT]`, or the runtime-error form. */
export interface ErrorAnnotation {
  readonly kind: 'compile-error' | 'runtime-error'
  readonly line: number
  /** `E\d{3}` for compile errors, `R\d{3}` for runtime errors; null when omitted. */
  readonly code: string | null
  /** Text the message must contain; null when omitted. */
  readonly text: string | null
  /** Text the hint must contain; null when omitted. */
  readonly hint: string | null
}

/** Anything else that starts with `// expect`; it fails the file. */
export interface MalformedAnnotation {
  readonly kind: 'malformed'
  readonly line: number
  /** The annotation from `// expect` to its end, trailing whitespace removed. */
  readonly raw: string
}

export type Annotation = OutputAnnotation | ErrorAnnotation | MalformedAnnotation

const MARKER = '// expect'
const OUTPUT_PREFIX = '// expect:'
const HINT_SEPARATOR = ' // hint:'

const ERROR_FORMS = [
  { prefix: '// expect compile error', kind: 'compile-error', codeLetter: 'E' },
  { prefix: '// expect runtime error', kind: 'runtime-error', codeLetter: 'R' },
] as const

/** Optional ` CODE`, then optional `:` with optional ` TEXT`. */
const ERROR_HEAD = /^(?: ([A-Z])(\d{3}))?(:(?: (.*))?)?$/

/** Every annotation in `source`, in file order (line by line, left to right). */
export function parseAnnotations(source: string): Annotation[] {
  const lines = new LineIndex(source)
  const annotations: Annotation[] = []
  for (let line = 1; line <= lines.lineCount; line++) {
    for (const raw of splitAnnotations(lines.lineText(line))) {
      annotations.push(parseAnnotation(raw, line))
    }
  }
  return annotations
}

/** Each occurrence of `// expect` starts an annotation that runs to the next one or the line end. */
export function splitAnnotations(lineText: string): string[] {
  const parts: string[] = []
  let start = lineText.indexOf(MARKER)
  while (start !== -1) {
    const next = lineText.indexOf(MARKER, start + MARKER.length)
    parts.push(next === -1 ? lineText.slice(start) : lineText.slice(start, next))
    start = next
  }
  return parts
}

/** Parses one annotation (text starting with `// expect`) found on `line`. */
export function parseAnnotation(raw: string, line: number): Annotation {
  const annotation = raw.trimEnd()
  if (annotation.startsWith(OUTPUT_PREFIX)) {
    return parseOutput(annotation, line)
  }
  for (const form of ERROR_FORMS) {
    if (annotation.startsWith(form.prefix)) {
      const parsed = parseErrorBody(annotation.slice(form.prefix.length), form.codeLetter)
      return parsed === null ? malformed(annotation, line) : { kind: form.kind, line, ...parsed }
    }
  }
  return malformed(annotation, line)
}

function parseOutput(annotation: string, line: number): Annotation {
  const rest = annotation.slice(OUTPUT_PREFIX.length)
  if (rest === '') return { kind: 'output', line, text: '' }
  if (!rest.startsWith(' ')) return malformed(annotation, line)
  return { kind: 'output', line, text: rest.slice(1) }
}

interface ErrorParts {
  readonly code: string | null
  readonly text: string | null
  readonly hint: string | null
}

/** Parses `[ CODE][: TEXT][ // hint: HINT]` (already trimmed at the end), or returns null. */
function parseErrorBody(body: string, codeLetter: 'E' | 'R'): ErrorParts | null {
  const hintAt = body.indexOf(HINT_SEPARATOR)
  const head = hintAt === -1 ? body : body.slice(0, hintAt)
  const hint = hintAt === -1 ? null : parseHint(body.slice(hintAt + HINT_SEPARATOR.length))
  if (hint === undefined) return null

  const match = ERROR_HEAD.exec(head)
  if (match === null) return null
  const [, letter, digits, colon, text] = match
  if (letter !== undefined && letter !== codeLetter) return null
  return {
    code: letter === undefined ? null : `${letter}${digits ?? ''}`,
    text: colon === undefined ? null : (text ?? '').trimEnd(),
    hint,
  }
}

/** The text after ` // hint:`: '' or ` HINT`. Returns undefined when malformed. */
function parseHint(rest: string): string | undefined {
  if (rest === '') return ''
  return rest.startsWith(' ') ? rest.slice(1).trimEnd() : undefined
}

function malformed(raw: string, line: number): MalformedAnnotation {
  return { kind: 'malformed', line, raw }
}
