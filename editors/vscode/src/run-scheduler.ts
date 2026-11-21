/**
 * Runs per document, newest first: a save schedules a run after a short pause (saves in a burst
 * make one run), and starting a run aborts the one still recording for the same document, whose
 * result is then dropped. Pure (timers are injected), so it is unit-tested without VS Code.
 */

export interface Timers {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Polled by `recordAsync` between slices. */
export interface AbortFlag {
  aborted: boolean
}

export type Job<R> = (signal: AbortFlag) => Promise<R>

interface Entry {
  timer: unknown
  signal: AbortFlag | null
}

export class RunScheduler {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly timers: Timers) {}

  /**
   * Runs `job` for `key` after `delayMs` unless another schedule or run for `key` comes first;
   * `done` gets the result of a run nothing superseded, `failed` the error of a job that threw.
   */
  schedule<R>(
    key: string,
    delayMs: number,
    job: Job<R>,
    done: (result: R) => void,
    failed: (error: unknown) => void = () => undefined,
  ): void {
    const entry = this.entry(key)
    if (entry.timer !== null) this.timers.clear(entry.timer)
    entry.timer = this.timers.set(() => {
      entry.timer = null
      this.run(key, job).then((result) => {
        if (result !== null) done(result.value)
      }, failed)
    }, delayMs)
  }

  /**
   * Runs `job` for `key` now, aborting the run in flight and any pending one. Resolves with the
   * result, or null when a newer run for `key` started before this one finished.
   */
  async run<R>(key: string, job: Job<R>): Promise<{ readonly value: R } | null> {
    const entry = this.entry(key)
    if (entry.timer !== null) {
      this.timers.clear(entry.timer)
      entry.timer = null
    }
    if (entry.signal !== null) entry.signal.aborted = true
    const signal: AbortFlag = { aborted: false }
    entry.signal = signal
    try {
      const value = await job(signal)
      return signal.aborted ? null : { value }
    } finally {
      if (entry.signal === signal) entry.signal = null
    }
  }

  /** Whether a run for `key` is recording or waiting to start. */
  busy(key: string): boolean {
    const entry = this.entries.get(key)
    return entry !== undefined && (entry.timer !== null || entry.signal !== null)
  }

  /** Stops whatever is pending or running for `key` (a closed document). */
  cancel(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    if (entry.timer !== null) this.timers.clear(entry.timer)
    if (entry.signal !== null) entry.signal.aborted = true
    this.entries.delete(key)
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) this.cancel(key)
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { timer: null, signal: null }
      this.entries.set(key, entry)
    }
    return entry
  }
}
