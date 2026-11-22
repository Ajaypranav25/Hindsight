/**
 * Starts the analysis worker. The normal build emits the worker as its own chunk; the single-file
 * page build swaps this module for analysis-worker-factory.inline.ts (vite.page.config.ts).
 */
import type { WorkerLike } from './client'

export function createAnalysisWorker(): WorkerLike {
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
    type: 'module',
    name: 'hindsight-analysis',
  })
}
