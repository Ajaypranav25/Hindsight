/**
 * Sliced execution for `recordAsync` and `extendAsync` (ARCHITECTURE §7.1.7): run for `sliceMs`,
 * report progress, yield through a `MessageChannel` macrotask (else `setTimeout(0)`), and end with
 * outcome `aborted` once the signal is set. Host facilities are reached through `globalThis` with
 * narrow local interfaces, so the core needs no DOM or Node types.
 */
import type { AsyncRecordOptions } from './api-types'
import type { RecordingCore, RecordingSession } from './recorder-session'

const DEFAULT_SLICE_MS = 8

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
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS
  for (;;) {
    if (options.signal?.aborted === true) return finish(session.abort(), options)
    const deadline = now() + sliceMs
    const core = session.run(() => now() >= deadline)
    if (core !== null) return finish(core, options)
    options.onProgress?.(session.currentTime)
    await yieldToHost()
  }
}

function finish(core: RecordingCore, options: AsyncRecordOptions): RecordingCore {
  options.onProgress?.(core.length)
  return core
}
