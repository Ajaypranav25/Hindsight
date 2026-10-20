import type { ValueView } from '../../core/api-types'

const GROUPED = new Intl.NumberFormat('en-US')

/** 1234567 → "1,234,567". */
export function formatCount(n: number): string {
  return GROUPED.format(n)
}

/** Compact step counts for axis labels: 950 → "950", 56_789 → "56.8k", 2_000_000 → "2M". */
export function formatSteps(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(n)
  if (abs < 1_000_000) return `${trimZeros((n / 1000).toFixed(abs < 10_000 ? 1 : 0))}k`
  return `${trimZeros((n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0))}M`
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

/** Tape-counter digits: 1234 with width 7 → "0 001 234" (groups of three from the right). */
export function tapeDigits(n: number, width: number): string {
  const digits = String(Math.max(0, Math.trunc(n))).padStart(width, '0')
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3)
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return groups.join(' ')
}

/** Hindsight's `repr` for strings (SPEC §4.3). */
export function reprString(text: string): string {
  let out = '"'
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (code < 0x20) out += `\\u{${code.toString(16)}}`
    else out += ch
  }
  return `${out}"`
}

/**
 * The most code units of one printed line or one string value the panels render. Programs can
 * build strings of many millions of characters; laying those out (or putting them in `title`
 * attributes) freezes the tab.
 */
export const DISPLAY_TEXT_LIMIT = 10_000

/** Where to cut `text` to keep at most `max` code units without splitting a surrogate pair. */
function cutAt(text: string, max: number): number {
  const code = text.charCodeAt(max - 1)
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max
}

function moreCharacters(n: number): string {
  return `… (${formatCount(n)} more ${n === 1 ? 'character' : 'characters'})`
}

/** `text`, or its first `max` code units followed by "… (N more characters)". */
export function clipText(text: string, max: number = DISPLAY_TEXT_LIMIT): string {
  if (text.length <= max) return text
  const end = cutAt(text, max)
  return text.slice(0, end) + moreCharacters(text.length - end)
}

/** One-line text for a value as tools show it: primitives in repr form, objects by preview. */
export function formatValue(value: ValueView): string {
  switch (value.kind) {
    case 'nil':
      return 'nil'
    case 'bool':
      return value.value ? 'true' : 'false'
    case 'number':
      return String(value.value)
    case 'string': {
      const text = value.value
      if (text.length <= DISPLAY_TEXT_LIMIT) return reprString(text)
      const end = cutAt(text, DISPLAY_TEXT_LIMIT)
      return reprString(text.slice(0, end)) + moreCharacters(text.length - end)
    }
    case 'ref':
      return value.preview
  }
}

/** Shortens text to at most `max` code units, ending with "…" when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Values compare equal for change highlighting when their displayed identity is the same. */
export function sameValue(a: ValueView, b: ValueView): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'nil':
      return true
    case 'ref':
      return b.kind === 'ref' && a.id === b.id && a.preview === b.preview
    default:
      return Object.is((a as { value: unknown }).value, (b as { value: unknown }).value)
  }
}
