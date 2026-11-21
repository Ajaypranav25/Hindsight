/**
 * Values for contract inference (ARCHITECTURE §7.16): a call's arguments and result read out of a
 * recording as plain data, and the few builtins the clause templates use (SPEC §9), evaluated on
 * that data. Only plain data is read in full: lists and records nested at most `MAX_NESTING` deep
 * with at most `MAX_ITEMS` elements; anything else keeps its type and length but not its contents,
 * so a template that needs the contents is undecided there (and is not suggested).
 */
import type { Recording, ValueView } from './api-types'

const MAX_ITEMS = 200
const MAX_NESTING = 4

export interface PlainList {
  readonly kind: 'list'
  readonly length: number
  /** Null when the list is too long, too deep or cyclic to read. */
  readonly items: readonly Plain[] | null
}

export interface PlainRecord {
  readonly kind: 'record'
  readonly length: number
  readonly entries: ReadonlyMap<string, Plain> | null
}

/** A function, range, builtin or iterator: only its type is known. */
export interface PlainOther {
  readonly kind: 'other'
  readonly type: 'function' | 'range' | 'iterator'
}

export type Plain = null | boolean | number | string | PlainList | PlainRecord | PlainOther

/** The value's type name as `type()` returns it; null for an iterator (not a language value). */
export function typeName(value: Plain): string | null {
  if (value === null) return 'nil'
  switch (typeof value) {
    case 'boolean':
      return 'bool'
    case 'number':
      return 'number'
    case 'string':
      return 'string'
  }
  if (value.kind === 'other') return value.type === 'iterator' ? null : value.type
  return value.kind
}

/** `value` at time `t` as plain data (bounded; see the module comment). */
export function plainValue(recording: Recording, t: number, value: ValueView): Plain {
  return new PlainReader(recording, t).read(value, 0)
}

class PlainReader {
  /** Objects being read (the current path), so a cycle is cut instead of followed. */
  private readonly path = new Set<number>()

  constructor(
    private readonly recording: Recording,
    private readonly t: number,
  ) {}

  /** Reads one value; recursion is bounded by MAX_NESTING. */
  read(value: ValueView, nesting: number): Plain {
    switch (value.kind) {
      case 'nil':
        return null
      case 'bool':
      case 'number':
      case 'string':
        return value.value
      case 'ref':
        return this.reference(value, nesting)
    }
  }

  private reference(value: ValueView & { kind: 'ref' }, nesting: number): Plain {
    if (value.type !== 'list' && value.type !== 'record') {
      return { kind: 'other', type: value.type === 'builtin' ? 'function' : value.type }
    }
    const object = this.recording.objectAt(this.t, value.id, { offset: 0, limit: MAX_ITEMS })
    if (object === null || (object.type !== 'list' && object.type !== 'record')) {
      return value.type === 'list'
        ? { kind: 'list', length: 0, items: null }
        : { kind: 'record', length: 0, entries: null }
    }
    const readable = nesting < MAX_NESTING && object.length <= MAX_ITEMS && !this.path.has(value.id)
    if (object.type === 'list') {
      if (!readable) return { kind: 'list', length: object.length, items: null }
      this.path.add(value.id)
      const items = object.items.map((item) => this.read(item, nesting + 1))
      this.path.delete(value.id)
      return { kind: 'list', length: object.length, items }
    }
    if (!readable) return { kind: 'record', length: object.length, entries: null }
    this.path.add(value.id)
    const entries = new Map(object.entries.map((e) => [e.key, this.read(e.value, nesting + 1)]))
    this.path.delete(value.id)
    return { kind: 'record', length: object.length, entries }
  }
}

/**
 * Equality as `==` decides it (SPEC §7.4) on plain data; null when it cannot be told (contents
 * that were not read, functions, ranges). Iterative, with an explicit work list.
 */
export function plainEquals(a: Plain, b: Plain): boolean | null {
  const work: [Plain, Plain][] = [[a, b]]
  let unknown = false
  for (let pair = work.pop(); pair !== undefined; pair = work.pop()) {
    const [x, y] = pair
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') {
      if (x !== y) return false
      continue
    }
    if (x.kind !== y.kind) return false
    if (x.kind === 'other' || y.kind === 'other') {
      unknown = true
      continue
    }
    if (x.length !== y.length) return false
    if (x.kind === 'list' && y.kind === 'list') {
      if (x.items === null || y.items === null) {
        unknown = true
        continue
      }
      for (let i = 0; i < x.items.length; i++) work.push([x.items[i]!, y.items[i]!])
      continue
    }
    if (x.kind === 'record' && y.kind === 'record') {
      if (x.entries === null || y.entries === null) {
        unknown = true
        continue
      }
      for (const [key, value] of x.entries) {
        if (!y.entries.has(key)) return false
        work.push([value, y.entries.get(key)!])
      }
    }
  }
  return unknown ? null : true
}

/** A canonical text for plain data (equal texts for equal values), for counting distinct inputs. */
export function plainKey(value: Plain): string {
  let out = ''
  const work: (Plain | { readonly text: string })[] = [value]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    if (item !== null && typeof item === 'object' && 'text' in item) {
      out += item.text
      continue
    }
    if (item === null || typeof item !== 'object') {
      out += typeof item === 'string' ? JSON.stringify(item) : String(item)
      continue
    }
    if (item.kind === 'other') {
      out += `<${item.type}>`
    } else if (item.kind === 'list') {
      if (item.items === null) out += `[…${item.length}]`
      else {
        work.push({ text: ']' })
        for (let i = item.items.length - 1; i >= 0; i--) {
          work.push(item.items[i]!)
          if (i > 0) work.push({ text: ',' })
        }
        work.push({ text: '[' })
      }
    } else if (item.entries === null) {
      out += `{…${item.length}}`
    } else {
      const entries = [...item.entries].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      work.push({ text: '}' })
      for (let i = entries.length - 1; i >= 0; i--) {
        work.push(entries[i]![1])
        work.push({ text: `${JSON.stringify(entries[i]![0])}:` })
        if (i > 0) work.push({ text: ',' })
      }
      work.push({ text: '{' })
    }
  }
  return out
}

// --- builtins on plain data ----------------------------------------------------------------------

/** `len(v)` for a list, string or record; null otherwise. */
export function plainLength(value: Plain): number | null {
  if (typeof value === 'string') return value.length
  if (value !== null && typeof value === 'object' && value.kind !== 'other') return value.length
  return null
}

/** The items of a fully read list; null otherwise. */
export function listItems(value: Plain): readonly Plain[] | null {
  return value !== null && typeof value === 'object' && value.kind === 'list' ? value.items : null
}

/** The items when they are all numbers (no NaN) or all strings, as `sort` requires. */
export function sortableItems(value: Plain): readonly (number | string)[] | null {
  const items = listItems(value)
  if (items === null) return null
  if (items.every((item) => typeof item === 'number' && !Number.isNaN(item))) {
    return items as readonly number[]
  }
  if (items.every((item) => typeof item === 'string')) return items as readonly string[]
  return null
}

/** `sort(xs)` on sortable items (numbers numerically, strings by code units). */
export function sortedItems(items: readonly (number | string)[]): (number | string)[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** A plain list of the given items. */
export function plainList(items: readonly Plain[]): PlainList {
  return { kind: 'list', length: items.length, items }
}

/** `contains(xs, v)` for a fully read list (null when undecided). */
export function listContains(items: readonly Plain[], value: Plain): boolean | null {
  let unknown = false
  for (const item of items) {
    const same = plainEquals(item, value)
    if (same === true) return true
    if (same === null) unknown = true
  }
  return unknown ? null : false
}

/** `uniq(xs)`: items without later duplicates (null when undecided). */
export function uniqueItems(items: readonly Plain[]): Plain[] | null {
  const kept: Plain[] = []
  for (const item of items) {
    const seen = listContains(kept, item)
    if (seen === null) return null
    if (!seen) kept.push(item)
  }
  return kept
}

/** `round(x)`: halves away from zero (SPEC §9.2). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}
