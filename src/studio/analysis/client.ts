/**
 * The main-thread side of the analysis worker (ARCHITECTURE §11.7). Two lanes, each with its own
 * worker started on first use: quick passes over a run (slices, queries) and searches that run
 * many forks or mutants (solve, repairs, sweeps), so a long search never holds up a slice. A lane
 * sends one job at a time and keeps the rest queued.
 *
 * Cancelling a queued job drops it. Cancelling the job in flight lets a search stop at its next
 * pause; a single pass is left to finish (its result is dropped) unless other work waits, in which
 * case the worker is terminated and a fresh one started. The same job asked for again right after
 * it was cancelled (React's development double effects) continues instead of starting over.
 *
 * Whenever no worker can be had (no `Worker`, a start-up error, a run that cannot be described or
 * recorded again), the job runs on the main thread through the fallback backend.
 */
import type { Recording } from '../../core/index'
import { AnalysisCancelled, type AnalysisBackend, type OnProgress } from './local'
import { type AnalysisRequest, type AnalysisResult, type FromWorker, isSearch } from './protocol'
import type { ToWorker } from './protocol'
import { describeRun, runKey } from './run-description'

/** The parts of a `Worker` the client uses. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(message: ToWorker, transfer: Transferable[]): void
  terminate(): void
}

export interface ClientOptions {
  /** Starts a worker; null when workers are unavailable. May throw. */
  readonly createWorker: (() => WorkerLike) | null
  /** Does the work on the main thread. */
  readonly fallback: AnalysisBackend
}

type LaneName = 'quick' | 'search'

interface Job {
  readonly id: number
  readonly key: string
  readonly recording: Recording
  readonly request: AnalysisRequest
  readonly message: ToWorker
  resolve: (result: AnalysisResult) => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
  onProgress: OnProgress | undefined
  /** The caller gave up; the job may still be adopted by an identical request. */
  orphaned: boolean
  /** A cancel message went to the worker. */
  cancelSent: boolean
}

export class AnalysisClient implements AnalysisBackend {
  private nextId = 1
  /** Set once a worker failed to start: everything then runs on the main thread. */
  private unavailable: boolean
  private readonly lanes: Record<LaneName, Lane>

  constructor(private readonly options: ClientOptions) {
    this.unavailable = options.createWorker === null
    const host: LaneHost = {
      createWorker: () => this.spawn(),
      fallback: (job) => this.runLocally(job),
      startFailed: () => {
        this.unavailable = true
      },
    }
    this.lanes = { quick: new Lane(host), search: new Lane(host) }
  }

  /** True while jobs go to workers (false after a worker failed to start, or without workers). */
  get usesWorkers(): boolean {
    return !this.unavailable
  }

  analyze(
    recording: Recording,
    request: AnalysisRequest,
    signal?: AbortSignal,
    onProgress?: OnProgress,
  ): Promise<AnalysisResult> {
    if (signal?.aborted === true) return Promise.reject(new AnalysisCancelled())
    const run = describeRun(recording)
    if (this.unavailable || run === null) {
      return this.options.fallback.analyze(recording, request, signal, onProgress)
    }
    const id = this.nextId++
    const message: ToWorker = { type: 'analyze', id, run, request }
    const key = `${runKey(run)}\n${JSON.stringify(request)}`
    return new Promise<AnalysisResult>((resolve, reject) => {
      const job: Job = {
        id,
        key,
        recording,
        request,
        message,
        resolve,
        reject,
        signal,
        onProgress,
        orphaned: false,
        cancelSent: false,
      }
      this.lanes[isSearch(request) ? 'search' : 'quick'].submit(job)
    })
  }

  /** Stops every worker (queued and running jobs are cancelled). */
  dispose(): void {
    this.lanes.quick.dispose()
    this.lanes.search.dispose()
  }

  private spawn(): WorkerLike | null {
    if (this.unavailable || this.options.createWorker === null) return null
    try {
      return this.options.createWorker()
    } catch {
      this.unavailable = true
      return null
    }
  }

  private runLocally(job: Job): void {
    this.options.fallback
      .analyze(job.recording, job.request, job.signal, job.onProgress)
      .then(job.resolve, job.reject)
  }
}

interface LaneHost {
  createWorker(): WorkerLike | null
  fallback(job: Job): void
  startFailed(): void
}

/** One worker and its queue. */
class Lane {
  private worker: WorkerLike | null = null
  private ready = false
  private current: Job | null = null
  private readonly queue: Job[] = []

  constructor(private readonly host: LaneHost) {}

  submit(job: Job): void {
    const current = this.current
    if (current !== null && current.orphaned && current.key === job.key && !current.cancelSent) {
      // The same job again: it continues for the new caller.
      this.adopt(current, job)
      return
    }
    this.watch(job)
    this.queue.push(job)
    if (current !== null && current.orphaned && !isSearch(current.request)) {
      // A pass nobody waits for would hold the new job up: start over with a fresh worker.
      this.restart()
      return
    }
    this.pump()
  }

  dispose(): void {
    const jobs = [...this.queue, ...(this.current === null ? [] : [this.current])]
    this.queue.length = 0
    this.current = null
    this.stop()
    for (const job of jobs) if (!job.orphaned) job.reject(new AnalysisCancelled())
  }

  private adopt(current: Job, job: Job): void {
    current.orphaned = false
    current.resolve = job.resolve
    current.reject = job.reject
    current.signal = job.signal
    current.onProgress = job.onProgress
    this.watch(current)
  }

  private watch(job: Job): void {
    const signal = job.signal
    if (signal === undefined) return
    signal.addEventListener('abort', () => this.cancel(job, signal), { once: true })
  }

  private cancel(job: Job, signal: AbortSignal): void {
    // A signal of a caller that was replaced by an adopting one no longer speaks for the job.
    if (job.signal !== signal || job.orphaned) return
    job.orphaned = true
    job.reject(new AnalysisCancelled())
    const queued = this.queue.indexOf(job)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      return
    }
    if (job !== this.current) return
    // Wait one task: the same job may be asked for again at once.
    setTimeout(() => {
      if (this.current !== job || !job.orphaned) return
      if (isSearch(job.request)) {
        job.cancelSent = true
        this.worker?.postMessage({ type: 'cancel', id: job.id }, [])
      } else if (this.queue.length > 0) {
        this.restart()
      }
    }, 0)
  }

  private pump(): void {
    if (this.current !== null) return
    const job = this.queue.shift()
    if (job === undefined) return
    if (this.worker === null) this.start()
    if (this.worker === null) {
      // No worker can be had: this and every queued job run on the main thread.
      this.host.fallback(job)
      return this.pump()
    }
    this.current = job
    this.worker.postMessage(job.message, [])
  }

  private start(): void {
    const worker = this.host.createWorker()
    if (worker === null) return
    this.worker = worker
    this.ready = false
    worker.onmessage = (event) => this.receive(worker, event.data as FromWorker)
    worker.onerror = (event) => {
      event.preventDefault?.()
      this.crashed(worker)
    }
    worker.onmessageerror = () => this.crashed(worker)
  }

  private receive(worker: WorkerLike, message: FromWorker): void {
    if (worker !== this.worker) return
    if (message.type === 'ready') {
      this.ready = true
      return
    }
    const job = this.current
    if (job === null || job.id !== message.id) return
    if (message.type === 'progress') {
      if (!job.orphaned) job.onProgress?.(message.done)
      return
    }
    this.current = null
    if (!job.orphaned) {
      if (message.type === 'done') job.resolve(message.result)
      else if (message.type === 'failed') this.host.fallback(job)
      else job.reject(new AnalysisCancelled())
    }
    this.pump()
  }

  /** The worker failed: before it was ready it never will be; later it is replaced. */
  private crashed(worker: WorkerLike): void {
    if (worker !== this.worker) return
    const wasReady = this.ready
    this.stop()
    if (!wasReady) this.host.startFailed()
    const job = this.current
    this.current = null
    if (job !== null && !job.orphaned) this.host.fallback(job)
    this.pump()
  }

  private restart(): void {
    const job = this.current
    this.current = null
    this.stop()
    if (job !== null && !job.orphaned) this.queue.unshift(job)
    this.pump()
  }

  private stop(): void {
    this.worker?.terminate()
    this.worker = null
    this.ready = false
  }
}
