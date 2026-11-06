/**
 * Sliced execution for `recordAsync` and `extendAsync` (ARCHITECTURE §7.1.7): run for `sliceMs`,
 * report progress, yield through a `MessageChannel` macrotask (else `setTimeout(0)`), and end with
 * outcome `aborted` once the signal is set. Host facilities are reached through `globalThis` with
 * narrow local interfaces, so the core needs no DOM or Node types.
 */
import type { AsyncRecordOptions } from './api-types'
import type { Pacer, RecordingCore, RecordingSession } from './recorder-session'

const DEFAULT_SLICE_MS = 8
/**
 * The most steps run between clock checks. The pacer only learns that steps are slow after a
 * batch has run, so this caps an unobserved slow stretch (a cheap loop followed by a loop of
 * slow natives); a clock read every 64 steps costs about 1% of recording time.
 */
export const MAX_CHECK_INTERVAL = 64
/** Clock checks aim to be about this far apart: an eighth of the slice, but at least 1 ms. */
const CHECK_TARGET_FRACTION = 1 / 8
const MIN_CHECK_TARGET_MS = 1

/**
 * Ends each slice at its deadline (§7.1.7). The check interval starts at one step and adapts at
 * every check: it doubles while the steps since the previous check took under an eighth of the
 * target spacing, and shrinks eightfold when they took over twice that. A loop of cheap steps soon
 * checks every MAX_CHECK_INTERVAL steps; once steps turn slow, checks come after every step, so a
 * slice overshoots its deadline by at most one batch and Stop is never far away. The interval
 * carries over between slices of one run.
 */
export class SlicePacer implements Pacer {
  interval = 1
  private deadline = 0
  private lastCheck = 0
  private readonly target: number

  constructor(
    private readonly sliceMs: number,
    private readonly clock: () => number,
  ) {
    this.target = Math.max(MIN_CHECK_TARGET_MS, sliceMs * CHECK_TARGET_FRACTION)
  }

  /** Starts a slice. */
  begin(): void {
    const time = this.clock()
    this.deadline = time + this.sliceMs
    this.lastCheck = time
  }

  due(): boolean {
    const time = this.clock()
    const elapsed = time - this.lastCheck
    this.lastCheck = time
    if (elapsed > 2 * this.target) this.interval = Math.max(1, this.interval >> 3)
    else if (elapsed < this.target / 8)
      this.interval = Math.min(MAX_CHECK_INTERVAL, this.interval * 2)
    return time >= this.deadline
  }
}

interface HostPort {
  onmessage: ((event: unknown) => void) | null
  postMessage(message: unknown): void
  close(): void
}

interface HostGlobals {
  readonly performance?: { now(): number }
  readonly MessageChannel?: new () => { readonly port1: HostPort; readonly port2: HostPort }
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
}

const host = globalThis as unknown as HostGlobals

function now(): number {
  return host.performance !== undefined ? host.performance.now() : Date.now()
}

/** Resolves on a fresh macrotask, letting the host render and handle input. */
export function yieldToHost(): Promise<void> {
  const Channel = host.MessageChannel
  if (Channel !== undefined) {
    return new Promise((resolve) => {
      const channel = new Channel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => {
    if (host.setTimeout !== undefined) host.setTimeout(resolve, 0)
    else resolve()
  })
}

export async function runSliced(
  session: RecordingSession,
  options: AsyncRecordOptions,
): Promise<RecordingCore> {
  const pacer = new SlicePacer(options.sliceMs ?? DEFAULT_SLICE_MS, now)
  for (;;) {
    if (options.signal?.aborted === true) return finish(session.abort(), options)
    pacer.begin()
    const core = session.run(pacer)
    if (core !== null) return finish(core, options)
    options.onProgress?.(session.currentTime)
    await yieldToHost()
  }
}

function finish(core: RecordingCore, options: AsyncRecordOptions): RecordingCore {
  options.onProgress?.(core.length)
  return core
}
