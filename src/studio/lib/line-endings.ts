/**
 * The editor (CodeMirror) keeps every line break as "\n", whatever text it is given, while the
 * store's program is matched against the editor's text offset by offset (highlights, diagnostics,
 * edits). So text that arrives from outside (files, links) has its line breaks normalized before it
 * reaches the store, and a file written back gets the line breaks it was read with.
 */

export type LineEnding = '\n' | '\r\n'

/** `text` with every "\r\n" and lone "\r" turned into "\n". */
export function normalizeLineEndings(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/** The line ending a file uses: its first line break decides ("\n" when it has none). */
export function lineEndingOf(text: string): LineEnding {
  const first = text.search(/\r\n|\r|\n/)
  return first >= 0 && text.startsWith('\r\n', first) ? '\r\n' : '\n'
}

/** Normalized `text` written with `ending` line breaks. */
export function withLineEnding(text: string, ending: LineEnding): string {
  const normal = normalizeLineEndings(text)
  return ending === '\n' ? normal : normal.replace(/\n/g, '\r\n')
}
