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

/** One-line text for a value as tools show it: primitives in repr form, objects by preview. */
export function formatValue(value: ValueView): string {
  switch (value.kind) {
    case 'nil':
      return 'nil'
    case 'bool':
      return value.value ? 'true' : 'false'
    case 'number':
      return String(value.value)
    case 'string':
      return reprString(value.value)
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
