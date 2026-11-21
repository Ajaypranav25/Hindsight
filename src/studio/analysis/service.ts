/**
 * The studio's analysis service (ARCHITECTURE §11.7): one client for the whole page, using
 * workers where the browser has them and the main thread otherwise. Tests may swap it.
 */
import type { Recording } from '../../core/index'
import { createAnalysisWorker } from './analysis-worker-factory'
import { AnalysisClient } from './client'
import { type AnalysisBackend, localAnalysis, type OnProgress } from './local'
import type { AnalysisRequest, ResultOf } from './protocol'

let service: AnalysisBackend | null = null

function createService(): AnalysisBackend {
  const workers = typeof Worker === 'function'
  return new AnalysisClient({
    createWorker: workers ? createAnalysisWorker : null,
    fallback: localAnalysis,
  })
}

/** The page's analysis service, created on first use. */
export function analysisService(): AnalysisBackend {
  service ??= createService()
  return service
}

/** Replaces the service (tests); null goes back to the default on next use. */
export function setAnalysisService(next: AnalysisBackend | null): void {
  service = next
}

/** Asks the page's service for `request` and checks that the answer is of the same kind. */
export async function analyze<K extends AnalysisRequest['kind']>(
  recording: Recording,
  request: Extract<AnalysisRequest, { kind: K }>,
  signal?: AbortSignal,
  onProgress?: OnProgress,
): Promise<ResultOf<K>> {
  const result = await analysisService().analyze(recording, request, signal, onProgress)
  if (result.kind !== request.kind) {
    throw new Error(`The analysis answered a ${result.kind} request instead of ${request.kind}.`)
  }
  return result as ResultOf<K>
}
