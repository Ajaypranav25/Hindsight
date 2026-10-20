import type { RuntimeErrorInfo, ValueView } from '../core/api-types'
import type { Diagnostic } from '../core/diagnostics'
import { repr } from '../core/index'
import { LineIndex, type Span } from '../core/span'

/** ANSI styling that collapses to plain text when color is off. */
export interface Style {
  readonly error: (text: string) => string
  readonly accent: (text: string) => string
  readonly dim: (text: string) => string
  readonly bold: (text: string) => string
  readonly ok: (text: string) => string
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`

export function makeStyle(color: boolean): Style {
  if (!color) {
    const plain = (text: string) => text
    return { error: plain, accent: plain, dim: plain, bold: plain, ok: plain }
  }
  return {
    error: wrap(31, 39),
    accent: wrap(36, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    ok: wrap(32, 39),
  }
}

/** C0 controls other than tab and newline, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

function escapeControl(character: string): string {
  return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
}

/**
 * Text from the program (source lines, messages, record keys, names, values) made safe for a
 * terminal: control characters other than tab and newline become visible `\xNN` escapes, so a
 * program cannot move the cursor, retitle the window or restyle the CLI's own output.
 */
export function sanitize(text: string): string {
  return text.replace(CONTROL_CHARACTERS, escapeControl)
}

/** A Rust-style code frame: the span's first line with a caret underline. */
export function codeFrame(source: string, span: Span, style: Style): string[] {
  const index = new LineIndex(source)
  const { line, col } = index.lineCol(span.start)
  const raw = index.lineText(line).replace(/\t/g, ' ')
  const text = sanitize(raw)
  const lineEnd = index.lineEnd(line)
  const width = Math.max(1, Math.min(span.end, lineEnd) - span.start)
  // Escapes widen the line, so the caret is placed by the sanitized prefix and span.
  const start = sanitize(raw.slice(0, col - 1)).length
  const shownWidth = Math.max(1, sanitize(raw.slice(col - 1, col - 1 + width)).length)
  const gutter = String(line).length
  const pad = ' '.repeat(gutter)
  const marker = `${' '.repeat(start)}${'^'.repeat(shownWidth)}${span.end > lineEnd ? ' …' : ''}`
  return [
    `${pad} ${style.dim('|')}`,
    `${style.dim(String(line))} ${style.dim('|')} ${text}`,
    `${pad} ${style.dim('|')} ${style.error(marker)}`,
  ]
}

function location(file: string, source: string, span: Span): string {
  const { line, col } = new LineIndex(source).lineCol(span.start)
  return `${sanitize(file)}:${line}:${col}`
}

/** Formats a compile diagnostic: `error[E020]: …`, location, code frame, hint. */
export function formatDiagnostic(
  file: string,
  source: string,
  diagnostic: Diagnostic,
  style: Style,
): string {
  const lines = [
    `${style.error(style.bold(`error[${diagnostic.code}]`))}${style.bold(`: ${sanitize(diagnostic.message)}`)}`,
    `  ${style.accent('-->')} ${location(file, source, diagnostic.span)}`,
    ...codeFrame(source, diagnostic.span, style).map((frameLine) => `  ${frameLine}`),
  ]
  if (diagnostic.hint) lines.push(`  ${style.accent('= hint:')} ${sanitize(diagnostic.hint)}`)
  return lines.join('\n')
}

/** Formats a runtime error with its code frame and call stack. */
export function formatRuntimeError(
  file: string,
  source: string,
  error: RuntimeErrorInfo,
  style: Style,
): string {
  const index = new LineIndex(source)
  const lines = [
    `${style.error(style.bold(`runtime error[${error.code}]`))}${style.bold(`: ${sanitize(error.message)}`)}`,
    `  ${style.accent('-->')} ${location(file, source, error.span)}`,
    ...codeFrame(source, error.span, style).map((frameLine) => `  ${frameLine}`),
  ]
  if (error.hint) lines.push(`  ${style.accent('= hint:')} ${sanitize(error.hint)}`)
  lines.push(
    `  ${style.dim(`after ${error.time.toLocaleString('en-US')} steps; stack (innermost first):`)}`,
  )
  for (const entry of error.stack) {
    const where = entry.library ? 'library' : `${sanitize(file)}:${index.lineOf(entry.span.start)}`
    lines.push(`    at ${sanitize(entry.name)} ${style.dim(`(${where})`)}`)
  }
  return lines.join('\n')
}

/** Primitives in `repr` form, objects by their preview; sanitized for the terminal. */
export function formatValueView(value: ValueView): string {
  return sanitize(valueViewText(value))
}

function valueViewText(value: ValueView): string {
  switch (value.kind) {
    case 'nil':
      return 'nil'
    case 'bool':
      return String(value.value)
    case 'number':
      return String(value.value)
    case 'string':
      return repr(value.value)
    case 'ref':
      return value.preview
  }
}
