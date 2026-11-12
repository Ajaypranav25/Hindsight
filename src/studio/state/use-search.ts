/**
 * Background searches for panels (ARCHITECTURE §11.3): work that runs many what-ifs or mutants
 * must not freeze the page, and must stop when the thing it searches is replaced.
 *
 * `useGeneratorSearch` drives a core generator (the repair search) a few steps per timer tick.
 * `useAsyncSearch` runs a core async search (the inverse what-if) with an abort signal. Both
 * restart when `key` changes and stop on unmount.
 */
import { useEffect, useState } from 'react'

export type Search<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'searching'; readonly progress: number }
  | { readonly status: 'done'; readonly result: T }

/** Time a search may work before it lets the page breathe. */
const SLICE_MS = 12

const IDLE = { status: 'idle' } as const

/**
 * Runs the generator `start()` returns to its end, in slices. `start` is called once per `key`
 * (null: no search); it yields a progress number after each unit of work.
 */
export function useGeneratorSearch<T>(
  key: unknown,
  start: () => Generator<number, T, void>,
): Search<T> {
  const [state, setState] = useState<{ readonly key: unknown; readonly search: Search<T> }>({
    key: null,
    search: IDLE,
  })
  useEffect(() => {
    if (key === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const search = start()
    const slice = (): void => {
      if (stopped) return
      const until = Date.now() + SLICE_MS
      let progress = 0
      for (;;) {
        const next = search.next()
        if (next.done === true) {
          setState({ key, search: { status: 'done', result: next.value } })
          return
        }
        progress = next.value
        if (Date.now() >= until) break
      }
      setState({ key, search: { status: 'searching', progress } })
      timer = setTimeout(slice, 0)
    }
    timer = setTimeout(slice, 0)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // `start` is read when the key changes; a new closure alone must not restart the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // Results of an earlier key are not this key's.
  if (key === null) return IDLE
  return state.key === key ? state.search : { status: 'searching', progress: 0 }
}

/**
 * Runs `start(signal)` once per `key` (null: no search). The signal's `aborted` turns true when
 * the key changes or the component unmounts; a result that arrives after that is dropped.
 */
export function useAsyncSearch<T>(
  key: unknown,
  start: (signal: { readonly aborted: boolean }) => Promise<T>,
): Search<T> {
  const [state, setState] = useState<{ readonly key: unknown; readonly search: Search<T> }>({
    key: null,
    search: IDLE,
  })
  useEffect(() => {
    if (key === null) return
    const signal = { aborted: false }
    void start(signal).then((result) => {
      if (!signal.aborted) setState({ key, search: { status: 'done', result } })
    })
    return () => {
      signal.aborted = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (key === null) return IDLE
  return state.key === key ? state.search : { status: 'searching', progress: 0 }
}
