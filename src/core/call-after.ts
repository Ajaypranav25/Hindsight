import type { CallNode } from './calls'

/**
 * The time just after the call, where its caller goes on (`exit + 1` without tasks; with tasks the
 * caller's next step, `CallNode.after`), or where the run stopped when it never returned.
 */
export function timeAfter(call: CallNode): number {
  if (call.after !== undefined) return call.after
  return call.outcome === 'returned' ? call.exit + 1 : call.exit
}
