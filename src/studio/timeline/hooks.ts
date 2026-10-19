/** Browser-observing hooks for the strip chart: element size, theme changes, reduced motion. */
import { useEffect, useState, type RefObject } from 'react'

export interface ElementSize {
  /** CSS pixels. */
  readonly width: number
  readonly height: number
  readonly dpr: number
}

const ZERO_SIZE: ElementSize = { width: 0, height: 0, dpr: 1 }

/** The element's content-box size, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>(ZERO_SIZE)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect
      if (!rect) return
      const next = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        dpr: window.devicePixelRatio || 1,
      }
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr
          ? prev
          : next,
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/** A counter that changes whenever the theme may have changed (data-theme or system scheme). */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(bump)
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style'],
    })
    const query =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    query?.addEventListener('change', bump)
    return () => {
      observer?.disconnect()
      query?.removeEventListener('change', bump)
    }
  }, [])
  return version
}

/** True when the user asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchReducedMotion()?.matches ?? false)
  useEffect(() => {
    const query = matchReducedMotion()
    if (!query) return
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

function matchReducedMotion(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
}
