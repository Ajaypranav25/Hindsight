/**
 * The studio's analysis service (ARCHITECTURE §11.7): one client for the whole page, using
 * workers where the browser has them and the main thread otherwise. Tests may swap it.
 */
import { createAnalysisWorker } from './analysis-worker-factory'
import { AnalysisClient } from './client'
import { type AnalysisBackend, localAnalysis } from './local'

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
