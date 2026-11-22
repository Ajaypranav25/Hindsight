/**
 * Swim lanes for runs with tasks (SPEC §10.6, ARCHITECTURE §11.3): one lane per task, each with the
 * call depth of its own steps and the stretches it spent waiting after it blocked. Like the depth
 * envelope (`timeline-math.ts`) a lane answers "min and max depth in this pixel column" in
 * O(log N) from a min/max mipmap; to stay small the mipmap starts at blocks of `LANE_BLOCK` steps
 * (levels below are read from the shared depth and task series), so a lane costs about N/4 small
 * integers whatever the run's length. Pure: no DOM.
 */
import type { TaskSwitch } from '../../core/api-types'
import { NO_DATA, type ColumnEnvelope } from './timeline-math'

/** Lanes drawn at most; further tasks share the last lane. */
export const MAX_LANES = 8
/** Steps per entry of a lane's first stored mipmap level. */
export const LANE_BLOCK = 8
/** Stored for "no step of this lane here" in min arrays (depths stay far below it). */
const EMPTY_MIN = 0x7fff

export interface Lane {
  /** `1 main`, `2 worker`, or `+3 more` for the shared last lane. */
  readonly label: string
  /** The tasks drawn in it. */
  readonly tasks: readonly number[]
  readonly maxDepth: number
  /** Waiting stretches `[start, end)`, flattened and in time order. */
  readonly waits: Float64Array
}

export interface LaneModel {
  readonly length: number
  readonly lanes: readonly Lane[]
  /** Lane index per task id (-1 for ids that never ran). */
  readonly laneOf: Int32Array
  readonly depths: Int32Array
  readonly tasks: Int32Array
  /** Per lane, its mipmap levels from blocks of `LANE_BLOCK` steps upwards. */
  readonly mins: readonly (readonly Int16Array[])[]
  readonly maxs: readonly (readonly Int16Array[])[]
}

/** What the model is built from: the recording's series, its switches and its task names. */
export interface LaneInput {
  readonly depths: Int32Array
  readonly tasks: Int32Array
  readonly switches: readonly TaskSwitch[]
  readonly names: ReadonlyMap<number, string>
}

export function buildLaneModel(input: LaneInput): LaneModel {
  const { depths, tasks } = input
  const length = Math.min(depths.length, tasks.length)
  let maxTask = 0
  for (let t = 0; t < length; t++) if (tasks[t]! > maxTask) maxTask = tasks[t]!
  for (const id of input.names.keys()) if (id > maxTask) maxTask = id
  const present: number[] = []
  const seen = new Uint8Array(maxTask + 1)
  for (let t = 0; t < length; t++) seen[tasks[t]!] = 1
  for (let id = 1; id <= maxTask; id++) if (seen[id] === 1) present.push(id)
  const own = present.length > MAX_LANES ? present.slice(0, MAX_LANES - 1) : present
  const shared = present.slice(own.length)
  const laneOf = new Int32Array(maxTask + 1).fill(-1)
  own.forEach((id, lane) => (laneOf[id] = lane))
  for (const id of shared) laneOf[id] = own.length
  const groups = shared.length > 0 ? [...own.map((id) => [id]), shared] : own.map((id) => [id])
  const laneCount = groups.length
  const { mins, maxs, maxDepths } = buildMipmaps(depths, tasks, laneOf, laneCount, length)
  const waits = waitStretches(input.switches, laneOf, laneCount, length)
  const lanes = groups.map((ids, lane) => ({
    label:
      ids.length === 1 ? `${ids[0]} ${input.names.get(ids[0]!) ?? 'task'}` : `+${ids.length} more`,
    tasks: ids,
    maxDepth: maxDepths[lane]!,
    waits: waits[lane]!,
  }))
  return { length, lanes, laneOf, depths, tasks, mins, maxs }
}

function buildMipmaps(
  depths: Int32Array,
  tasks: Int32Array,
  laneOf: Int32Array,
  laneCount: number,
  length: number,
) {
  const blocks = Math.ceil(length / LANE_BLOCK)
  const mins: Int16Array[][] = []
  const maxs: Int16Array[][] = []
  const maxDepths = new Int32Array(laneCount)
  for (let lane = 0; lane < laneCount; lane++) {
    mins.push([new Int16Array(blocks).fill(EMPTY_MIN)])
    maxs.push([new Int16Array(blocks).fill(NO_DATA)])
  }
  for (let t = 0; t < length; t++) {
    const lane = laneOf[tasks[t]!]!
    const depth = Math.min(depths[t]!, EMPTY_MIN - 1)
    const block = (t / LANE_BLOCK) | 0
    const min = mins[lane]![0]!
    const max = maxs[lane]![0]!
    if (depth < min[block]!) min[block] = depth
    if (depth > max[block]!) max[block] = depth
    if (depth > maxDepths[lane]!) maxDepths[lane] = depth
  }
  for (let lane = 0; lane < laneCount; lane++) {
    const laneMins = mins[lane]!
    const laneMaxs = maxs[lane]!
    while (laneMins[laneMins.length - 1]!.length > 1) {
      const prevMin = laneMins[laneMins.length - 1]!
      const prevMax = laneMaxs[laneMaxs.length - 1]!
      const size = Math.ceil(prevMin.length / 2)
      const min = new Int16Array(size)
      const max = new Int16Array(size)
      for (let i = 0; i < size; i++) {
        const a = 2 * i
        const b = a + 1 < prevMin.length ? a + 1 : a
        min[i] = Math.min(prevMin[a]!, prevMin[b]!)
        max[i] = Math.max(prevMax[a]!, prevMax[b]!)
      }
      laneMins.push(min)
      laneMaxs.push(max)
    }
  }
  return { mins, maxs, maxDepths }
}

/**
 * Per lane, the stretches its tasks spent waiting: from the switch at which a task blocked until
 * the switch back to it (or the end of the run).
 */
function waitStretches(
  switches: readonly TaskSwitch[],
  laneOf: Int32Array,
  laneCount: number,
  length: number,
): Float64Array[] {
  const lists: number[][] = Array.from({ length: laneCount }, () => [])
  const since = new Map<number, number>()
  for (const each of switches) {
    const started = since.get(each.to)
    if (started !== undefined) {
      since.delete(each.to)
      const lane = laneOf[each.to] ?? -1
      if (lane >= 0) lists[lane]!.push(started, each.time)
    }
    if (each.state === 'blocked') since.set(each.from, each.time)
  }
  for (const [task, started] of since) {
    const lane = laneOf[task] ?? -1
    if (lane >= 0) lists[lane]!.push(started, length)
  }
  return lists.map((list) => Float64Array.from(sortPairs(list)))
}

function sortPairs(flat: number[]): number[] {
  const pairs: [number, number][] = []
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i]!, flat[i + 1]!])
  pairs.sort((a, b) => a[0] - b[0])
  return pairs.flat()
}

/** Min and max depth of `lane`'s steps in `[from, to)`; null when it has none there. */
export function laneRange(
  model: LaneModel,
  lane: number,
  from: number,
  to: number,
): { min: number; max: number } | null {
  let lo = Math.max(0, Math.floor(from))
  let hi = Math.min(model.length, Math.ceil(to))
  let min = EMPTY_MIN
  let max = NO_DATA
  const visit = (t: number) => {
    if (model.laneOf[model.tasks[t]!] !== lane) return
    const depth = model.depths[t]!
    if (depth < min) min = depth
    if (depth > max) max = depth
  }
  while (lo < hi && lo % LANE_BLOCK !== 0) visit(lo++)
  while (hi > lo && hi % LANE_BLOCK !== 0) visit(--hi)
  let l = lo / LANE_BLOCK
  let h = hi / LANE_BLOCK
  const mins = model.mins[lane]!
  const maxs = model.maxs[lane]!
  for (let level = 0; l < h; level++) {
    const levelMins = mins[level]!
    const levelMaxs = maxs[level]!
    if (l & 1) {
      if (levelMins[l]! < min) min = levelMins[l]!
      if (levelMaxs[l]! > max) max = levelMaxs[l]!
      l++
    }
    if (h & 1) {
      h--
      if (levelMins[h]! < min) min = levelMins[h]!
      if (levelMaxs[h]! > max) max = levelMaxs[h]!
    }
    l >>= 1
    h >>= 1
  }
  return max === NO_DATA ? null : { min, max }
}

/** Per pixel column, the lane's min and max depth over the view (NO_DATA where it has no step). */
export function laneEnvelope(
  model: LaneModel,
  lane: number,
  viewStart: number,
  viewEnd: number,
  columns: number,
): ColumnEnvelope {
  const count = Math.max(0, Math.floor(columns))
  const min = new Int32Array(count).fill(NO_DATA)
  const max = new Int32Array(count).fill(NO_DATA)
  const span = viewEnd - viewStart
  if (count === 0 || !(span > 0)) return { min, max }
  for (let c = 0; c < count; c++) {
    const from = Math.floor(viewStart + (c * span) / count)
    const to = Math.max(from + 1, Math.ceil(viewStart + ((c + 1) * span) / count))
    const range = laneRange(model, lane, from, to)
    if (range) {
      min[c] = range.min
      max[c] = range.max
    }
  }
  return { min, max }
}

/** The lane and depth of step `t` (the last step's at N). */
export function laneAt(model: LaneModel, t: number): { lane: number; depth: number } {
  if (model.length === 0) return { lane: 0, depth: 0 }
  const step = Math.max(0, Math.min(model.length - 1, Math.floor(t)))
  return { lane: Math.max(0, model.laneOf[model.tasks[step]!]!), depth: model.depths[step]! }
}
