/**
 * The worker side of the analysis protocol (ARCHITECTURE §11.7), free of worker globals so tests
 * can drive it directly. Jobs run one at a time. The run of the latest job is kept, so several
 * analyses of one run record it only once. A search works in slices and looks for cancellations
 * between them; a single pass (a slice, a query) runs to its end.
 */
import type { Recording } from '../../core/index'
import { analysisJob, type Job } from './compute'
import {
  type AnalysisResult,
  type FromWorker,
  reportsProgress,
  type RunDescription,
  type ToWorker,
  transferablesOf,
} from './protocol'
import { type Recreated, recreateRun, runKey } from './run-description'

export interface HandlerHost {
  post(message: FromWorker, transfer: Transferable[]): void
  /** Runs `callback` after pending messages have been delivered (a macrotask). */
  schedule?(callback: () => void): void
  now?(): number
  /** Records a described run again (tests replace it). */
  recreate?(run: RunDescription): Recreated
}

/** How long a search works before it lets cancellations in. */
export const WORKER_SLICE_MS = 40

type Analyze = Extract<ToWorker, { type: 'analyze' }>

interface Running {
  readonly id: number
  readonly job: Job<AnalysisResult>
  /** Units of work done (pauses), counted for jobs that report progress. */
  units: number
  readonly progress: boolean
}

/** Returns the function that handles each message the main thread sends. */
export function createAnalysisHandler(host: HandlerHost): (message: ToWorker) => void {
  const schedule = host.schedule ?? macrotask()
  const now = host.now ?? (() => Date.now())
  const recreate = host.recreate ?? recreateRun
  const queue: Analyze[] = []
  const cancelled = new Set<number>()
  let running: Running | null = null
  let kept: { readonly key: string; readonly recording: Recording } | null = null

  const recordingOf = (run: RunDescription): Recording | string => {
    const key = runKey(run)
    if (kept !== null && kept.key === key) return kept.recording
    kept = null
    const made = recreate(run)
    if (!made.ok) return made.error
    kept = { key, recording: made.recording }
    return made.recording
  }

  const finish = (message: FromWorker, transfer: Transferable[] = []): void => {
    running = null
    host.post(message, transfer)
    startNext()
  }

  const advance = (): void => {
    const current = running
    if (current === null) return
    if (cancelled.delete(current.id)) return finish({ type: 'cancelled', id: current.id })
    const until = now() + WORKER_SLICE_MS
    const before = current.units
    try {
      let next = current.job.next()
      while (next.done !== true && now() < until) {
        current.units++
        next = current.job.next()
      }
      if (next.done === true) {
        const result = next.value
        return finish({ type: 'done', id: current.id, result }, transferablesOf(result))
      }
      current.units++
    } catch (error) {
      return finish({ type: 'failed', id: current.id, error: describeError(error) })
    }
    if (current.progress && current.units !== before) {
      host.post({ type: 'progress', id: current.id, done: current.units }, [])
    }
    schedule(advance)
  }

  const startNext = (): void => {
    const message = queue.shift()
    if (message === undefined) return
    if (cancelled.delete(message.id)) {
      host.post({ type: 'cancelled', id: message.id }, [])
      return startNext()
    }
    let recording: Recording | string
    try {
      recording = recordingOf(message.run)
    } catch (error) {
      recording = describeError(error)
    }
    if (typeof recording === 'string') {
      host.post({ type: 'failed', id: message.id, error: recording }, [])
      return startNext()
    }
    running = {
      id: message.id,
      job: analysisJob(recording, message.request),
      units: 0,
      progress: reportsProgress(message.request),
    }
    advance()
  }

  return (message) => {
    if (message.type === 'cancel') {
      const queued = queue.findIndex((entry) => entry.id === message.id)
      if (queued >= 0) {
        queue.splice(queued, 1)
        host.post({ type: 'cancelled', id: message.id }, [])
      } else if (running?.id === message.id) {
        cancelled.add(message.id)
      }
      return
    }
    queue.push(message)
    if (running === null) startNext()
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ChannelPort {
  onmessage: (() => void) | null
  postMessage(message: null): void
}

/** A zero-delay macrotask through a MessageChannel (timers are clamped), else `setTimeout`. */
function macrotask(): (callback: () => void) => void {
  const Channel = (
    globalThis as { MessageChannel?: new () => { port1: ChannelPort; port2: ChannelPort } }
  ).MessageChannel
  if (Channel === undefined) return (callback) => void setTimeout(callback, 0)
  const channel = new Channel()
  const waiting: (() => void)[] = []
  channel.port1.onmessage = () => waiting.shift()?.()
  return (callback) => {
    waiting.push(callback)
    channel.port2.postMessage(null)
  }
}
