/** Moves breakpoint lines with document edits, the way CodeMirror maps positions. */
import type { ChangeDesc, Text } from '@codemirror/state'

/** The span a line occupies together with one adjacent line break (the one deleting it removes). */
function lineExtent(doc: Text, lineNumber: number): { from: number; to: number } {
  const line = doc.line(lineNumber)
  if (lineNumber < doc.lines) return { from: line.from, to: line.to + 1 }
  return { from: lineNumber > 1 ? line.from - 1 : line.from, to: line.to }
}

/** True when one deletion removes the whole line (its text and its line break). */
function lineDeleted(doc: Text, lineNumber: number, changes: ChangeDesc): boolean {
  const extent = lineExtent(doc, lineNumber)
  if (extent.from === extent.to) return false
  let deleted = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= extent.from && toA >= extent.to) deleted = true
  })
  return deleted
}

/**
 * The breakpoint lines after `changes` turned `before` into `after`: each follows the start of
 * its line (text inserted above pushes it down, a joined line pulls it up) and breakpoints on
 * deleted lines are dropped. Returns `lines` itself when nothing moved.
 */
export function mapBreakpointLines(
  lines: ReadonlySet<number>,
  before: Text,
  changes: ChangeDesc,
  after: Text,
): ReadonlySet<number> {
  if (lines.size === 0 || changes.empty) return lines
  const mapped = new Set<number>()
  let moved = false
  for (const lineNumber of lines) {
    if (lineNumber < 1 || lineNumber > before.lines || lineDeleted(before, lineNumber, changes)) {
      moved = true
      continue
    }
    const pos = changes.mapPos(before.line(lineNumber).from, 1)
    const next = after.lineAt(pos).number
    if (next !== lineNumber) moved = true
    mapped.add(next)
  }
  return moved || mapped.size !== lines.size ? mapped : lines
}
