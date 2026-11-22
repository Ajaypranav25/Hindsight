/**
 * Delta restores (ARCHITECTURE §6.8): positioning a machine that was itself positioned by a restore
 * at another snapshot of the same line, by refilling only the live objects that differ.
 *
 * Invariant: every object in `m.live` matches its copy in `m.base` unless the change log names it
 * (objects created since the base are not in `m.live`). So the objects that may differ from the
 * target's copies are those in the change log plus those whose copies differ between the two tables,
 * found by diffing the radix trees, which share all unchanged nodes. Those are refilled in place;
 * every other live object is reused as it is, so references between live objects stay valid. A
 * list whose copies are both persistent vectors is patched at the indices that may differ (the
 * change log's element writes and changed tails, and the indices whose slots differ between its two
 * copies) instead of being rebuilt. Objects absent from the target stay in `m.live`, unreachable,
 * and are refilled if a later restore needs them again.
 */
import { PVec } from './pvec'
import type { HeapObject } from './runtime-types'
import { FrozenList, type FrozenObject } from './vm-snapshot-frozen'
import type { MachineSnapshot } from './vm-snapshot'
import { Thawer } from './vm-snapshot-thaw'
import type { MachineState } from './vm-state'

/** What the change log says about a list: element indices written and the smallest changed tail. */
interface ListChange {
  readonly points: number[]
  tail: number
}

/** A thawer that reuses the machine's live objects for `target`, or null for a full restore. */
export function deltaThawer(m: MachineState, target: MachineSnapshot): Thawer | null {
  const base = m.base
  const live = m.live
  if (base === null || live === null || base.lineage !== target.lineage) return null
  const dirty = new Set<number>()
  const lists = new Map<number, ListChange>()
  readLog(m.changeLog, dirty, lists)
  base.table.diff(target.table, (id) => dirty.add(id))
  const thawer = new Thawer(target.table, live)
  const work: [HeapObject, FrozenObject][] = []
  for (const id of dirty) {
    const object = live.get(id)
    if (object === undefined) continue
    const frozen = target.table.get(id)
    if (frozen === undefined) continue
    if (frozen.kind !== object.type) return null
    work.push([object, frozen])
  }
  for (const [object, frozen] of work) {
    if (object.type === 'list' && frozen instanceof FrozenList) {
      const indices = listIndices(base.table.get(object.id), frozen, lists.get(object.id))
      if (indices !== null) {
        thawer.patch(object, frozen, indices)
        continue
      }
    }
    thawer.refresh(object, frozen)
  }
  return thawer
}

/** Collects the ids the change log names and, for lists, what changed (full: tail 0). */
function readLog(
  log: readonly unknown[],
  dirty: Set<number>,
  lists: Map<number, ListChange>,
): void {
  for (let i = 0; i < log.length; i += 2) {
    const object = log[i] as HeapObject
    dirty.add(object.id)
    if (object.type !== 'list') continue
    let change = lists.get(object.id)
    if (change === undefined) {
      change = { points: [], tail: Infinity }
      lists.set(object.id, change)
    }
    const detail = log[i + 1] as number
    if (detail >= 0) change.points.push(detail)
    else change.tail = Math.min(change.tail, -1 - detail)
  }
}

/** Patching beats refilling while at most this fraction of a list's items may differ. */
const PATCH_FRACTION = 8

/**
 * The sorted indices at which a live list (its base copy changed as `change` says) may differ from
 * `target`, or null when a whole refill is simpler (small copies, or too many differences).
 */
function listIndices(
  previous: FrozenObject | undefined,
  target: FrozenList,
  change: ListChange | undefined,
): number[] | null {
  if (!(previous instanceof FrozenList)) return null
  if (!(previous.items instanceof PVec) || !(target.items instanceof PVec)) return null
  const length = target.length
  const limit = Math.floor(length / PATCH_FRACTION)
  const tail = Math.min(change?.tail ?? Infinity, length)
  const points = change?.points ?? []
  if (length - tail + points.length > limit) return null
  // Indices from the diff come in ascending order; stop collecting once there are too many.
  const differing: number[] = []
  let tooMany = false
  previous.items.diff(target.items, (index) => {
    if (index >= tail || tooMany) return
    if (differing.length + points.length >= limit) tooMany = true
    else differing.push(index)
  })
  if (tooMany) return null
  const merged = mergeSorted(
    points.filter((index) => index < tail).sort((a, b) => a - b),
    differing,
  )
  for (let index = tail; index < length; index++) merged.push(index)
  return merged
}

/** The union of two ascending lists, ascending and without repeats. */
function mergeSorted(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i]! <= b[j]!) ? a[i++]! : b[j++]!
    if (out.length === 0 || out[out.length - 1] !== next) out.push(next)
  }
  return out
}
