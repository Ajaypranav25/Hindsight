/**
 * A stand-in for the analysis worker in tests: the real protocol handler behind a message port
 * that copies every message with `structuredClone` (so results must be plain, transferable data)
 * and delivers it a task later, as a worker would.
 */
import type { WorkerLike } from './client'
import { createAnalysisHandler, type HandlerHost } from './handler'
import type { FromWorker, ToWorker } from './protocol'

export interface FakeWorkerOptions {
  /** Never says it is ready, and fails on its first message (a worker that cannot start). */
  readonly broken?: boolean
  readonly recreate?: HandlerHost['recreate']
}

export class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  terminated = false
  readonly received: ToWorker[] = []
  private readonly handle: (message: ToWorker) => void

  constructor(private readonly options: FakeWorkerOptions = {}) {
    this.handle = createAnalysisHandler({
      post: (message, transfer) => this.send(message, transfer),
      schedule: (callback) => void setTimeout(callback, 0),
      recreate: options.recreate,
    })
    if (options.broken !== true) this.send({ type: 'ready' }, [])
  }

  postMessage(message: ToWorker, transfer: Transferable[]): void {
    const copy = structuredClone(message, { transfer })
    this.received.push(copy)
    setTimeout(() => {
      if (this.terminated) return
      if (this.options.broken === true) {
        this.onerror?.({ preventDefault: () => {} } as unknown as ErrorEvent)
        return
      }
      this.handle(copy)
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }

  /** What the main thread receives, as a crash of the worker would deliver it. */
  crash(): void {
    this.onerror?.({ preventDefault: () => {} } as unknown as ErrorEvent)
  }

  private send(message: FromWorker, transfer: Transferable[]): void {
    const copy = structuredClone(message, { transfer })
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: copy } as MessageEvent)
    }, 0)
  }
}
