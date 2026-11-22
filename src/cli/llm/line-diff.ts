/**
 * A unified diff of two versions of a program that differ in one region (a rewritten function):
 * the common lines at both ends are trimmed, the middle is aligned by a longest common subsequence
 * (iterative table, bounded; past the bound the region is shown as removed then added), and one
 * hunk is printed with a little context.
 */

/** The largest table (old lines × new lines) aligned; larger regions are not aligned. */
export const MAX_DIFF_CELLS = 250_000
const CONTEXT = 2

interface Op {
  readonly kind: ' ' | '-' | '+'
  readonly text: string
}

/** The middle region's lines as kept, removed and added, in order. */
function align(a: readonly string[], b: readonly string[]): Op[] {
  const removedThenAdded = (): Op[] => [
    ...a.map((text): Op => ({ kind: '-', text })),
    ...b.map((text): Op => ({ kind: '+', text })),
  ]
  if (a.length * b.length > MAX_DIFF_CELLS) return removedThenAdded()
  const width = b.length + 1
  // lengths[i * width + j]: the LCS length of a[i..] and b[j..].
  const lengths = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i]! })
      i += 1
      j += 1
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      ops.push({ kind: '-', text: a[i]! })
      i += 1
    } else {
      ops.push({ kind: '+', text: b[j]! })
      j += 1
    }
  }
  for (; i < a.length; i++) ops.push({ kind: '-', text: a[i]! })
  for (; j < b.length; j++) ops.push({ kind: '+', text: b[j]! })
  return ops
}

/** The diff as lines (`@@ -l,n +l,m @@`, then ` `, `-` and `+` lines); empty when equal. */
export function unifiedDiff(before: string, after: string): string[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const lead = Math.max(0, prefix - CONTEXT)
  const trail = Math.min(suffix, CONTEXT)
  const ops: Op[] = [
    ...a.slice(lead, prefix).map((text): Op => ({ kind: ' ', text })),
    ...align(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a
      .slice(a.length - suffix, a.length - suffix + trail)
      .map((text): Op => ({ kind: ' ', text })),
  ]
  const oldCount = ops.filter((op) => op.kind !== '+').length
  const newCount = ops.filter((op) => op.kind !== '-').length
  return [
    `@@ -${lead + 1},${oldCount} +${lead + 1},${newCount} @@`,
    ...ops.map((op) => `${op.kind}${op.text}`),
  ]
}
