/**
 * Asking the analysis service for an insight about the shown run, once it is on screen: a hook
 * that keeps the answer for one recording and one request, and drops it when either changes.
 */
import { useEffect, useState } from 'react'
import type { Recording } from '../../core/index'
import { AnalysisCancelled } from '../analysis/local'
import type { AnalysisRequest, ResultOf } from '../analysis/protocol'
import { analyze } from '../analysis/service'

/** A short pause first, so a burst of changes asks only once. */
export const INSIGHT_DELAY_MS = 60

export type InsightState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'failed'; readonly error: string }

interface Answer<T> {
  readonly recording: Recording
  readonly key: string
  readonly state: InsightState<T>
}

const IDLE = { status: 'idle' } as const
const WORKING = { status: 'working' } as const

/**
 * The answer to `request` about `recording` (nothing is asked while either is null). The key is
 * the request's JSON, so an equal request built anew does not ask again.
 */
export function useInsight<K extends AnalysisRequest['kind']>(
  recording: Recording | null,
  request: Extract<AnalysisRequest, { kind: K }> | null,
): InsightState<ResultOf<K>> {
  const key = request === null ? null : JSON.stringify(request)
  const [answer, setAnswer] = useState<Answer<ResultOf<K>> | null>(null)
  useEffect(() => {
    if (recording === null || request === null || key === null) return
    const controller = new AbortController()
    const settle = (state: InsightState<ResultOf<K>>) => setAnswer({ recording, key, state })
    const timer = setTimeout(() => {
      analyze(recording, request, controller.signal).then(
        (value) => settle({ status: 'done', value }),
        (error: unknown) => {
          if (error instanceof AnalysisCancelled || controller.signal.aborted) return
          settle({
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }, INSIGHT_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // The request is identified by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, key])
  if (recording === null || key === null) return IDLE
  if (answer === null || answer.recording !== recording || answer.key !== key) return WORKING
  return answer.state
}
