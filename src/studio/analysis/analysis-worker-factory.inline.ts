/**
 * The single-file page's analysis worker: bundled into the page itself and started from a blob
 * URL, so the page stays one self-contained file (vite.page.config.ts aliases this module in place
 * of analysis-worker-factory.ts).
 */
import InlineAnalysisWorker from './analysis.worker.ts?worker&inline'
import type { WorkerLike } from './client'

export function createAnalysisWorker(): WorkerLike {
  return new InlineAnalysisWorker({ name: 'hindsight-analysis' })
}
