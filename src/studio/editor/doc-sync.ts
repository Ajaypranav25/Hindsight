/** Pure helpers for keeping the editor document in step with the store. */

export interface TextChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/** The smallest single replacement turning `before` into `after` (keeps the cursor stable). */
export function minimalChange(before: string, after: string): TextChange | null {
  if (before === after) return null
  const max = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++
  let suffix = 0
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++
  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  }
}
