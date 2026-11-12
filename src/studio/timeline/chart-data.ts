/** Per-recording data for the strip chart, computed once and memoized. */
import { useCallback, useMemo, useState } from 'react'
import type { Recording } from '../../core/api-types'
import { queryTimes } from '../../core/index'
import { useStudio } from '../state/context'
import { liveQuery, liveSweep } from '../state/lab'
import type { ChartLab } from './chart-lab'
import type { ChartWhatIf } from './chart-whatif'
import {
  buildEnvelope,
  followTime,
  fullViewport,
  mergeTimes,
  type DepthEnvelope,
  type Viewport,
} from '../lib/timeline-math'

export interface ChartData {
  readonly env: DepthEnvelope | null
  readonly outputTimes: Float64Array
  readonly breakpointTimes: Float64Array
  readonly watchTimes: Float64Array
}

const NO_TIMES = new Float64Array(0)

export function useChartData(recording: Recording | null): ChartData {
  const breakpoints = useStudio((s) => s.breakpoints)
  const watch = useStudio((s) => s.watch)
  const env = useMemo(
    () => (recording ? buildEnvelope(recording.depthSeries()) : null),
    [recording],
  )
  const outputTimes = useMemo(
    () => (recording ? Float64Array.from(recording.outputs, (event) => event.time) : NO_TIMES),
    [recording],
  )
  const breakpointTimes = useMemo(
    () =>
      recording && breakpoints.size > 0
        ? mergeTimes([...breakpoints].map((line) => recording.lineHits(line)))
        : NO_TIMES,
    [recording, breakpoints],
  )
  const watchTimes = useMemo(() => {
    if (!recording || !watch) return NO_TIMES
    const at = Math.min(Math.max(0, watch.at), recording.length)
    return Float64Array.from(recording.history(watch.target, at).events, (event) => event.time)
  }, [recording, watch])
  return useMemo(
    () => ({ env, outputTimes, breakpointTimes, watchTimes }),
    [env, outputTimes, breakpointTimes, watchTimes],
  )
}

export type ViewUpdate = (update: (view: Viewport) => Viewport) => void

/**
 * The chart's zoom, owned by the recording it was made for (a new recording shows the whole run).
 * When the pen moves outside a zoomed view, the view re-centers on it.
 */
export function useViewport(
  recording: Recording | null,
  time: number,
  extent = 0,
): readonly [Viewport, ViewUpdate] {
  // A sweep's runs can outlast the run on display: the chart then spans the longest of them.
  const length = Math.max(recording?.length ?? 0, extent)
  const [zoom, setZoom] = useState<{ owner: Recording | null; view: Viewport }>(() => ({
    owner: recording,
    view: fullViewport(length),
  }))
  const [followed, setFollowed] = useState(time)
  const whole = useMemo(() => fullViewport(length), [length])
  const current = zoom.owner === recording ? zoom.view : whole
  if (followed !== time) {
    setFollowed(time)
    const next = followTime(current, time, length)
    if (next !== current) setZoom({ owner: recording, view: next })
  }
  const update = useCallback<ViewUpdate>(
    (fn) =>
      setZoom((prev) => ({
        owner: recording,
        view: fn(prev.owner === recording ? prev.view : fullViewport(length)),
      })),
    [recording, length],
  )
  return [current, update] as const
}

const NO_INTERVALS: ChartLab['intervals'] = []

/** The query and sweep layers' data, and the steps the chart must span to show the sweep. */
export function useChartLab(): { readonly lab: ChartLab | null; readonly extent: number } {
  const query = useStudio((s) => liveQuery(s.lab, s.recording))
  const sweep = useStudio((s) => liveSweep(s.lab, s.recording))
  const runs = sweep?.runs ?? null
  const forkTime = sweep?.time ?? 0
  const ghosts = useMemo(
    () => (runs ?? []).map((run) => buildEnvelope(run.recording.depthSeries())),
    [runs],
  )
  const extent = useMemo(
    () => (runs ?? []).reduce((longest, run) => Math.max(longest, run.recording.length), 0),
    [runs],
  )
  const lab = useMemo((): ChartLab | null => {
    if (query === null && ghosts.length === 0) return null
    const when = query?.result.kind === 'when'
    return {
      intervals: when && query.result.kind === 'when' ? query.result.intervals : NO_INTERVALS,
      moments: query === null || when ? NO_TIMES : Float64Array.from(queryTimes(query.result)),
      ghosts,
      forkTime,
    }
  }, [query, ghosts, forkTime])
  return useMemo(() => ({ lab, extent }), [lab, extent])
}

/** The what-if layers' data while a what-if is shown (the ghost is built once per real run). */
export function useChartWhatIf(): ChartWhatIf | null {
  const parent = useStudio((s) => s.whatIf?.parent ?? null)
  const forkTime = useStudio((s) => s.whatIf?.edits[0]?.time ?? null)
  const divergence = useStudio((s) => s.whatIf?.comparison.divergence ?? null)
  const ghost = useMemo(() => (parent ? buildEnvelope(parent.depthSeries()) : null), [parent])
  return useMemo(
    () => (ghost && forkTime !== null ? { ghost, forkTime, divergence } : null),
    [ghost, forkTime, divergence],
  )
}
