/**
 * The analysis worker's entry (ARCHITECTURE §11.7): wires the protocol handler to the worker's
 * message port. Everything else lives in handler.ts, which tests drive without a worker.
 */
import { createAnalysisHandler } from './handler'
import type { FromWorker, ToWorker } from './protocol'

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer: Transferable[]): void
}

const scope = self as unknown as WorkerScope
const handle = createAnalysisHandler({
  post: (message, transfer) => scope.postMessage(message, transfer),
})
scope.onmessage = (event) => handle(event.data)
scope.postMessage({ type: 'ready' }, [])
