/** Half-open range of UTF-16 code-unit offsets into a source string: `start <= i < end`. */
export interface Span {
  readonly start: number
  readonly end: number
}

export function span(start: number, end: number): Span {
  return { start, end }
}

/** The smallest span covering both `a` and `b`. */
export function joinSpans(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) }
}

/** A 1-based line and column (columns count UTF-16 code units). */
export interface LineCol {
  readonly line: number
  readonly col: number
}

/** Maps offsets to 1-based line/column positions. Lines end at `\n`, `\r\n` or `\r`. */
export class LineIndex {
  private readonly starts: readonly number[]

  constructor(readonly source: string) {
    const starts = [0]
    for (let i = 0; i < source.length; i++) {
      const ch = source.charCodeAt(i)
      if (ch === 13 /* \r */) {
        if (source.charCodeAt(i + 1) === 10 /* \n */) i++
        starts.push(i + 1)
      } else if (ch === 10 /* \n */) {
        starts.push(i + 1)
      }
    }
    this.starts = starts
  }

  get lineCount(): number {
    return this.starts.length
  }

  /** 1-based line containing `offset` (clamped into the source). */
  lineOf(offset: number): number {
    const target = Math.max(0, Math.min(offset, this.source.length))
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid]! <= target) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  lineCol(offset: number): LineCol {
    const line = this.lineOf(offset)
    const clamped = Math.max(0, Math.min(offset, this.source.length))
    return { line, col: clamped - this.starts[line - 1]! + 1 }
  }

  /** Offset of the first character of a 1-based line (clamped to the valid line range). */
  lineStart(line: number): number {
    const index = Math.max(1, Math.min(line, this.starts.length)) - 1
    return this.starts[index]!
  }

  /** Offset just past the last character of a line's text (before its terminator). */
  lineEnd(line: number): number {
    const clamped = Math.max(1, Math.min(line, this.starts.length))
    let end = clamped < this.starts.length ? this.starts[clamped]! : this.source.length
    if (end > this.starts[clamped - 1]! && this.source.charCodeAt(end - 1) === 10) end--
    if (end > this.starts[clamped - 1]! && this.source.charCodeAt(end - 1) === 13) end--
    return end
  }

  /** The text of a line without its terminator. */
  lineText(line: number): string {
    return this.source.slice(this.lineStart(line), this.lineEnd(line))
  }
}
