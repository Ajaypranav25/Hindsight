/** Per-recording data for the strip chart, computed once and memoized. */
import { useCallback, useMemo, useState } from 'react'
import type { Recording } from '../../core/api-types'
import { useStudio } from '../state/context'
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
): readonly [Viewport, ViewUpdate] {
  const length = recording?.length ?? 0
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
