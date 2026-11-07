/**
 * Value texts for the bug finder (ARCHITECTURE §7.6), built only from the public Recording API.
 *
 * `valueText` shows a value the way the studio does: primitives in `repr` form, objects by their
 * inspector preview. `deepText` renders the whole value at a time by paging through `objectAt`:
 * in `key` mode it identifies a value for memoization (functions by proto and captures) and gives
 * up (null) on anything it cannot compare safely; in `display` mode it reads like `repr`.
 */
import type { ObjectView, Recording, ValueView } from './api-types'
import { preview } from './values'
import { reprKey, reprWithin } from './values-show'

/** Longest string text shown in a question, in code units (longer strings end with "…"). */
export const STRING_TEXT_LIMIT = 200
/** The inspector's preview length (ARCHITECTURE §7.4): texts of objects match it. */
export const PREVIEW_LENGTH = 48
/** Values whose full text is longer than this are never treated as identical to another. */
export const KEY_TEXT_LIMIT = 4096

const PAGE = 100
/** Deeper nesting is not compared (it keeps the renderer's recursion bounded). */
const MAX_NESTING = 32
const ELLIPSIS = '…'

export type TextMode = 'key' | 'display'

/** As tools show values: primitives in `repr` form, objects by their preview. */
export function valueText(value: ValueView): string {
  switch (value.kind) {
    case 'nil':
      return 'nil'
    case 'bool':
      return value.value ? 'true' : 'false'
    case 'number':
      return String(value.value)
    case 'string':
      return preview(value.value, STRING_TEXT_LIMIT)
    case 'ref':
      return value.preview
  }
}

/** `text` cut to `max` code units, ending with "…" when cut (as previews are). */
export function cutText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + ELLIPSIS
}

export interface DeepText {
  readonly text: string
  /** False when the text stops at the limit. */
  readonly complete: boolean
}

/**
 * The text of `value` at time `t`, up to about `limit` code units; null when an object cannot be
 * read at `t` or, in key mode, cannot be compared (iterators, cycles, very deep nesting).
 */
export function deepText(
  recording: Recording,
  t: number,
  value: ValueView,
  mode: TextMode,
  limit: number,
): DeepText | null {
  const renderer = new DeepRenderer(recording, t, mode, limit)
  if (!renderer.value(value, 0)) return null
  return { text: renderer.out, complete: !renderer.cut }
}

/** The full text of `value` for comparing calls, or null when there is none. */
export function keyText(recording: Recording, t: number, value: ValueView): string | null {
  const text = deepText(recording, t, value, 'key', KEY_TEXT_LIMIT)
  return text !== null && text.complete ? text.text : null
}

class DeepRenderer {
  out = ''
  cut = false
  /** Objects being rendered (ancestors of the current position), for cycle detection. */
  private readonly path = new Set<number>()

  constructor(
    private readonly recording: Recording,
    private readonly t: number,
    private readonly mode: TextMode,
    private readonly limit: number,
  ) {}

  /** Appends `value`; false when the value cannot be rendered. */
  value(value: ValueView, nesting: number): boolean {
    if (this.out.length > this.limit) {
      this.cut = true
      return true
    }
    if (value.kind === 'string') {
      const room = this.limit - this.out.length
      const text = reprWithin(value.value, room)
      if (text === null) this.cut = true
      this.out += text ?? preview(value.value, Math.max(1, room))
      return true
    }
    if (value.kind !== 'ref') {
      this.out += valueText(value)
      return true
    }
    return this.reference(value, nesting)
  }

  private reference(value: ValueView & { kind: 'ref' }, nesting: number): boolean {
    if (this.path.has(value.id)) return this.cycle(value)
    if (this.mode === 'display' && value.type !== 'list' && value.type !== 'record') {
      this.out += value.preview
      return true
    }
    if (nesting >= MAX_NESTING) return false
    const object = this.recording.objectAt(this.t, value.id, { offset: 0, limit: PAGE })
    if (object === null) return false
    this.path.add(value.id)
    const done = this.object(object, nesting + 1)
    this.path.delete(value.id)
    return done
  }

  private cycle(value: ValueView & { kind: 'ref' }): boolean {
    if (this.mode === 'key') return false
    this.out += value.type === 'list' ? '[...]' : value.type === 'record' ? '{...}' : value.preview
    return true
  }

  private object(object: ObjectView, nesting: number): boolean {
    switch (object.type) {
      case 'list':
        return this.list(object, nesting)
      case 'record':
        return this.record(object, nesting)
      case 'function': {
        this.out += `<fn#${object.protoId} ${object.name ?? ''}>(`
        const done = object.captures.every((capture, i) => {
          this.out += `${i > 0 ? ', ' : ''}${capture.name}=`
          return this.value(capture.value, nesting)
        })
        this.out += ')'
        return done
      }
      case 'builtin':
        this.out += `<builtin ${object.name}>`
        return true
      case 'range':
        this.out += rangeText(object)
        return true
      case 'iterator':
        return false
    }
  }

  private list(first: ObjectView & { type: 'list' }, nesting: number): boolean {
    this.out += '['
    let page: ObjectView | null = first
    for (let index = 0; index < first.length; index++) {
      if (page === null || page.type !== 'list') return false
      if (index >= page.offset + page.items.length) {
        page = this.recording.objectAt(this.t, first.id, { offset: index, limit: PAGE })
        if (page === null || page.type !== 'list') return false
      }
      if (index > 0) this.out += ', '
      if (!this.value(page.items[index - page.offset]!, nesting)) return false
      if (this.cut) return true
    }
    this.out += ']'
    return true
  }

  private record(first: ObjectView & { type: 'record' }, nesting: number): boolean {
    this.out += '{'
    let page: ObjectView | null = first
    for (let index = 0; index < first.length; index++) {
      if (page === null || page.type !== 'record') return false
      if (index >= page.offset + page.entries.length) {
        page = this.recording.objectAt(this.t, first.id, { offset: index, limit: PAGE })
        if (page === null || page.type !== 'record') return false
      }
      const entry = page.entries[index - page.offset]!
      this.out += `${index > 0 ? ', ' : ''}${reprKey(entry.key)}: `
      if (!this.value(entry.value, nesting)) return false
      if (this.cut) return true
    }
    this.out += '}'
    return true
  }
}

function rangeText(range: ObjectView & { type: 'range' }): string {
  const start = String(range.start)
  const end = String(range.end)
  if (range.step !== 1) return `range(${start}, ${end}, ${String(range.step)})`
  return start + (range.inclusive ? '..=' : '..') + end
}
