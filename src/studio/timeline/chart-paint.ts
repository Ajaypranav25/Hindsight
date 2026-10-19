/** Paints the strip chart in requestAnimationFrame whenever its inputs change. */
import { useEffect, useRef, type RefObject } from 'react'
import { approach } from '../lib/timeline-math'
import { drawChart, readChartColors, type ChartScene } from './chart-draw'

/** Everything the chart shows except colors, which are read from CSS at paint time. */
export type PaintInput = Omit<ChartScene, 'colors' | 'progress'> & {
  /** Target share of the step budget recorded so far, or null when not recording. */
  readonly progress: number | null
  readonly reducedMotion: boolean
  /** Changes when the theme may have changed, so colors are re-read. */
  readonly themeVersion: number
}

/** Time constant of the pen's glide while a run records. */
const PEN_GLIDE_MS = 180

export function useChartPaint(canvasRef: RefObject<HTMLCanvasElement | null>, input: PaintInput) {
  const shown = useRef(0)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || input.width <= 0 || input.height <= 0) return
    const deviceWidth = Math.round(input.width * input.dpr)
    const deviceHeight = Math.round(input.height * input.dpr)
    if (canvas.width !== deviceWidth) canvas.width = deviceWidth
    if (canvas.height !== deviceHeight) canvas.height = deviceHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const colors = readChartColors(canvas)
    const { reducedMotion, themeVersion: _theme, progress: target, ...scene } = input
    if (target === null) shown.current = 0
    let frameId = 0
    let last = performance.now()
    const paint = (now: number) => {
      let progress: number | null = null
      if (target !== null) {
        shown.current = reducedMotion
          ? target
          : approach(shown.current, target, now - last, PEN_GLIDE_MS)
        progress = shown.current
      }
      last = now
      drawChart(ctx, { ...scene, colors, progress })
      if (progress !== null && progress !== target) frameId = requestAnimationFrame(paint)
    }
    frameId = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frameId)
  }, [canvasRef, input])
}
