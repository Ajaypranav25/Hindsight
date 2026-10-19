/**
 * Structural equality (SPEC §7.4). Re-exported by values.ts.
 *
 * The rule "a comparison already in progress further up counts as equal" makes the result exactly
 * bisimilarity, so a pair that was already scheduled anywhere can be treated as equal: either it is
 * still being verified (an ancestor) or it was verified already, and a mismatch anywhere ends the
 * whole comparison. Iterative, so nesting depth is unlimited.
 */
import type { HeapObject, ListObj, RangeObj, RecordObj, Value } from './runtime-types'

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return structurallyEqual(a, b)
}

/** Pairs of containers already scheduled for comparison. */
class PairSet {
  private readonly pairs = new Map<HeapObject, Set<HeapObject>>()

  /** Adds the pair; returns false when it was already present. */
  add(a: HeapObject, b: HeapObject): boolean {
    let partners = this.pairs.get(a)
    if (partners === undefined) {
      partners = new Set()
      this.pairs.set(a, partners)
    } else if (partners.has(b)) {
      return false
    }
    partners.add(b)
    return true
  }
}

function structurallyEqual(first: HeapObject, second: HeapObject): boolean {
  // Pending pairs, flattened: [a0, b0, a1, b1, …].
  const work: Value[] = [first, second]
  const scheduled = new PairSet()
  while (work.length > 0) {
    const b = work.pop() as Value
    const a = work.pop() as Value
    if (a === b) continue
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
    if (a.type !== b.type) return false
    if (!compareShallow(a, b, work, scheduled)) return false
  }
  return true
}

/** Checks what can be checked locally and schedules the children of containers. */
function compareShallow(a: HeapObject, b: HeapObject, work: Value[], scheduled: PairSet): boolean {
  switch (a.type) {
    case 'list':
      return scheduleList(a, b as ListObj, work, scheduled)
    case 'record':
      return scheduleRecord(a, b as RecordObj, work, scheduled)
    case 'range':
      return rangesEqual(a, b as RangeObj)
    default:
      // Functions, iterators and cells are equal only to themselves (checked by the caller).
      return false
  }
}

function scheduleList(a: ListObj, b: ListObj, work: Value[], scheduled: PairSet): boolean {
  if (a.items.length !== b.items.length) return false
  if (!scheduled.add(a, b)) return true
  // Pushed in reverse so the leftmost items are compared first.
  for (let i = a.items.length - 1; i >= 0; i--) work.push(a.items[i], b.items[i])
  return true
}

function scheduleRecord(a: RecordObj, b: RecordObj, work: Value[], scheduled: PairSet): boolean {
  if (a.fields.size !== b.fields.size) return false
  if (!scheduled.add(a, b)) return true
  for (const [key, value] of a.fields) {
    if (!b.fields.has(key)) return false
    work.push(value, b.fields.get(key) as Value)
  }
  return true
}

function rangesEqual(a: RangeObj, b: RangeObj): boolean {
  return a.start === b.start && a.end === b.end && a.step === b.step && a.inclusive === b.inclusive
}
