import { useCallback, useSyncExternalStore } from 'react'

export type LayoutMode = 'desktop' | 'tablet' | 'phone'

/** Breakpoints of ARCHITECTURE §11.2; layout.css uses the same widths. */
export const DESKTOP_QUERY = '(min-width: 1100px)'
export const PHONE_QUERY = '(max-width: 699.98px)'

/** Whether a media query matches; `fallback` where matchMedia is unavailable. */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaList(query)
      if (!list) return () => {}
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const read = () => mediaList(query)?.matches ?? fallback
  return useSyncExternalStore(subscribe, read, () => fallback)
}

function mediaList(query: string): MediaQueryList | null {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(query) : null
}

/** Desktop shows the panels stacked; tablet and phone show them as tabs. */
export function useLayoutMode(): LayoutMode {
  const desktop = useMediaQuery(DESKTOP_QUERY, true)
  const phone = useMediaQuery(PHONE_QUERY, false)
  if (desktop) return 'desktop'
  return phone ? 'phone' : 'tablet'
}
