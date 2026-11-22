/**
 * Background searches for panels (ARCHITECTURE §11.3, §11.7): work that runs many what-ifs or
 * mutants must not freeze the page, and must stop when the thing it searches is replaced. The
 * searches themselves run in the analysis service (a worker where there is one, else sliced on
 * the main thread); this hook ties one to a component.
 */
import { useEffect, useState } from 'react'

export type Search<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'searching'; readonly progress: number }
  | { readonly status: 'done'; readonly result: T }
  | { readonly status: 'failed'; readonly error: string }

const IDLE = { status: 'idle' } as const

/**
 * Runs `start(signal)` once per `key` (null: no search). The signal is aborted when the key
 * changes or the component unmounts; whatever arrives after that is dropped. A search that fails
 * for another reason ends as `failed`.
 */
export function useAsyncSearch<T>(
  key: unknown,
  start: (signal: AbortSignal) => Promise<T>,
): Search<T> {
  const [state, setState] = useState<{ readonly key: unknown; readonly search: Search<T> }>({
    key: null,
    search: IDLE,
  })
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    const { signal } = controller
    start(signal).then(
      (result) => {
        if (!signal.aborted) setState({ key, search: { status: 'done', result } })
      },
      (error: unknown) => {
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setState({ key, search: { status: 'failed', error: message } })
      },
    )
    return () => controller.abort()
    // `start` is read when the key changes; a new closure alone must not restart the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  // Results of an earlier key are not this key's.
  if (key === null) return IDLE
  return state.key === key ? state.search : { status: 'searching', progress: 0 }
}
