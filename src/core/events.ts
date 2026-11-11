/**
 * The event log by time (ARCHITECTURE §7.7): every declaration, write, allocation, list change and
 * field delete of a recording in the order it happened. `Recording.history` answers "what happened
 * to this target"; this answers "what happened during these steps".
 */
import type { HistoryResult, ProvenanceEvent, Recording } from './api-types'
import { decodeEvent } from './provenance-index'
import { replayAccess } from './recorder'
import { EventCode } from './trace-columns'

/** The most events `eventsBetween` returns unless told otherwise. */
export const DEFAULT_EVENT_LIMIT = 10_000

/**
 * The events with `from <= time < to`, in time order: the first `limit` of them, with the `total`
 * in the window (`truncated` when there are more). A recording this module cannot read (one that
 * `record` did not make) has none.
 */
export function eventsBetween(
  recording: Recording,
  from: number,
  to: number,
  limit: number = DEFAULT_EVENT_LIMIT,
): HistoryResult {
  const access = replayAccess(recording)
  if (access === null) return { events: [], total: 0, truncated: false }
  const { events, eventCount } = access.core
  const events_: ProvenanceEvent[] = []
  let total = 0
  for (let row = events.firstRowAt(Math.max(0, from), eventCount); row < eventCount; row++) {
    if (events.times[row]! >= to) break
    if (events.kinds[row] === EventCode.cellClosed) continue
    total += 1
    if (events_.length < limit) events_.push(decodeEvent(events, row))
  }
  return { events: events_, total, truncated: total > events_.length }
}
