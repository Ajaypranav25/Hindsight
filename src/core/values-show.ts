/**
 * Text representations (SPEC §4.3): `show`, `repr`, and bounded variants. Re-exported by values.ts.
 *
 * Rendering is iterative (an explicit cursor stack), so nesting depth is unlimited. A rendering
 * limit stops the work as soon as the text is longer than the limit; the partial text is always a
 * prefix of the full representation.
 */
import { InternalError } from './diagnostics'
import type { HeapObject, ListObj, RangeObj, RecordObj, Value } from './runtime-types'
import { isKeyword } from './tokens'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const ELLIPSIS = '…'

/** Numbers print as JavaScript `String(n)`. */
export function formatNumber(value: number): string {
  return String(value)
}

/** `show` (print, str, join, interpolation): strings as themselves, everything else as `repr`. */
export function show(value: Value): string {
  return typeof value === 'string' ? value : render(value, Infinity)
}

export function repr(value: Value): string {
  return render(value, Infinity)
}

/** `show(value)`, or null when it would be longer than `limit` code units. */
export function showWithin(value: Value, limit: number): string | null {
  if (typeof value === 'string') return value.length > limit ? null : value
  return fit(render(value, limit), limit)
}

/** `repr(value)`, or null when it would be longer than `limit` code units. */
export function reprWithin(value: Value, limit: number): string | null {
  return fit(render(value, limit), limit)
}

/**
 * `repr(value)` cut to at most `maxLength` code units: when longer, its first `maxLength - 1` code
 * units followed by an ellipsis (SPEC §11 truncated reprs). Stops rendering early.
 */
export function preview(value: Value, maxLength: number): string {
  if (maxLength <= 0) return ''
  const text = render(value, maxLength)
  return text.length <= maxLength ? text : text.slice(0, maxLength - 1) + ELLIPSIS
}

/** A record key as written by `repr`: bare when it is an identifier and not a keyword. */
export function reprKey(key: string): string {
  return isBareKey(key) ? key : quote(key, Infinity)
}

function isBareKey(key: string): boolean {
  return IDENTIFIER.test(key) && !isKeyword(key)
}

function fit(text: string, limit: number): string | null {
  return text.length > limit ? null : text
}

// ---------------------------------------------------------------------------------------------
// Strings

/**
 * The quoted, escaped form of `text`. When `text` is longer than `maxUnits`, only its first
 * `maxUnits` code units are escaped and no closing quote is added: the caller only needs to see
 * that the result is too long, and a prefix of code units escapes to a prefix of the full text.
 */
function quote(text: string, maxUnits: number): string {
  const complete = text.length <= maxUnits
  const source = complete ? text : text.slice(0, maxUnits)
  return '"' + escape(source) + (complete ? '"' : '')
}

function escape(text: string): string {
  let out = ''
  let chunkStart = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0x20 && unit !== 0x22 && unit !== 0x5c) continue
    out += text.slice(chunkStart, i) + escapeUnit(unit)
    chunkStart = i + 1
  }
  return chunkStart === 0 ? text : out + text.slice(chunkStart)
}

function escapeUnit(unit: number): string {
  switch (unit) {
    case 0x22:
      return '\\"'
    case 0x5c:
      return '\\\\'
    case 0x0a:
      return '\\n'
    case 0x09:
      return '\\t'
    case 0x0d:
      return '\\r'
    default:
      return `\\u{${unit.toString(16)}}`
  }
}

// ---------------------------------------------------------------------------------------------
// Atoms (everything that is not a list or record)

type Container = ListObj | RecordObj

function isContainer(value: Value): value is Container {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value.type === 'list' || value.type === 'record')
  )
}

/** `budget` bounds how much of a string is escaped (see `quote`). */
function atom(value: Value, budget: number): string {
  if (value === null) return 'nil'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return formatNumber(value)
    case 'string':
      return quote(value, Math.max(0, budget))
    default:
      return heapAtom(value)
  }
}

function heapAtom(value: HeapObject): string {
  switch (value.type) {
    case 'closure':
      if (value.id < 0) return `<builtin ${value.proto.name ?? ''}>`
      return value.proto.name === null ? '<fn>' : `<fn ${value.proto.name}>`
    case 'native':
      return `<builtin ${value.name}>`
    case 'range':
      return rangeText(value)
    case 'iterator':
      return '<iterator>'
    case 'cell':
      return '<cell>'
    default:
      throw new InternalError(`${value.type} is not an atom`)
  }
}

function rangeText(range: RangeObj): string {
  const start = formatNumber(range.start)
  const end = formatNumber(range.end)
  if (range.step !== 1) return `range(${start}, ${end}, ${formatNumber(range.step)})`
  return start + (range.inclusive ? '..=' : '..') + end
}

// ---------------------------------------------------------------------------------------------
// Containers

interface ListCursor {
  readonly kind: 'list'
  readonly list: ListObj
  index: number
}

interface RecordCursor {
  readonly kind: 'record'
  readonly record: RecordObj
  readonly entries: Iterator<[string, Value]>
  first: boolean
}

type Cursor = ListCursor | RecordCursor

/** `repr(value)`, stopping once the text is longer than `limit`. */
function render(value: Value, limit: number): string {
  return isContainer(value) ? new Renderer(limit).run(value) : atom(value, limit)
}

class Renderer {
  private out = ''
  /** The containers being printed (ancestors of the current position), for cycle detection. */
  private readonly path = new Set<Container>()
  private readonly cursors: Cursor[] = []

  constructor(private readonly limit: number) {}

  run(root: Container): string {
    this.enter(root)
    while (this.cursors.length > 0 && this.out.length <= this.limit) {
      const cursor = this.cursors[this.cursors.length - 1]
      if (cursor.kind === 'list') this.advanceList(cursor)
      else this.advanceRecord(cursor)
    }
    return this.out
  }

  private advanceList(cursor: ListCursor): void {
    const items = cursor.list.items
    if (cursor.index >= items.length) {
      this.leave(cursor.list, ']')
      return
    }
    if (cursor.index > 0) this.out += ', '
    this.emit(items[cursor.index++])
  }

  private advanceRecord(cursor: RecordCursor): void {
    const next = cursor.entries.next()
    if (next.done === true) {
      this.leave(cursor.record, '}')
      return
    }
    if (!cursor.first) this.out += ', '
    cursor.first = false
    const [key, value] = next.value
    this.out += (isBareKey(key) ? key : quote(key, this.budget())) + ': '
    this.emit(value)
  }

  private emit(value: Value): void {
    if (!isContainer(value)) {
      this.out += atom(value, this.budget())
    } else if (this.path.has(value)) {
      this.out += value.type === 'list' ? '[...]' : '{...}'
    } else {
      this.enter(value)
    }
  }

  private enter(container: Container): void {
    this.path.add(container)
    if (container.type === 'list') {
      this.out += '['
      this.cursors.push({ kind: 'list', list: container, index: 0 })
    } else {
      this.out += '{'
      const entries = container.fields.entries()
      this.cursors.push({ kind: 'record', record: container, entries, first: true })
    }
  }

  private leave(container: Container, closer: string): void {
    this.out += closer
    this.path.delete(container)
    this.cursors.pop()
  }

  private budget(): number {
    return this.limit - this.out.length
  }
}
