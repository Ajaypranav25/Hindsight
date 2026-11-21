/**
 * The main-thread fallback (ARCHITECTURE §11.7): the studio's original code paths, used when no
 * worker can be started (tests under jsdom, a page that forbids workers) or a worker cannot do a
 * job. Single passes run after the page has painted; searches keep the page responsive with
 * sliced forks (the inverse what-if, sweeps) or by working a few milliseconds at a time (repairs).
 */
import { solveInverseAsync, sweepAsync, type Recording } from '../../core/index'
import { queryOutcome, repairJob, sliceSummary, sweepRunSummary, type Job } from './compute'
import type { AnalysisRequest, AnalysisResult } from './protocol'

/** Time a search may work on the main thread before it lets the page breathe. */
export const LOCAL_SLICE_MS = 12

/** Raised by an analysis whose signal was aborted. */
export class AnalysisCancelled extends Error {
  constructor() {
    super('The analysis was cancelled.')
    this.name = 'AnalysisCancelled'
  }
}

export interface AnalysisBackend {
  analyze(
    recording: Recording,
    request: AnalysisRequest,
    signal?: AbortSignal,
  ): Promise<AnalysisResult>
}

const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function check(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AnalysisCancelled()
}

/** Runs a job in slices of `LOCAL_SLICE_MS`, yielding to the page between them. */
async function drive<T>(job: Job<T>, signal: AbortSignal | undefined): Promise<T> {
  for (;;) {
    await later()
    check(signal)
    const until = Date.now() + LOCAL_SLICE_MS
    let next = job.next()
    while (next.done !== true && Date.now() < until) next = job.next()
    if (next.done === true) return next.value
  }
}

export const localAnalysis: AnalysisBackend = {
  async analyze(recording, request, signal) {
    check(signal)
    switch (request.kind) {
      case 'slice':
        await later()
        check(signal)
        return { kind: 'slice', slice: sliceSummary(recording, request.at) }
      case 'query':
        await later()
        check(signal)
        return { kind: 'query', outcome: queryOutcome(recording, request.text, request.limit) }
      case 'solve': {
        const result = await solveInverseAsync(recording, request.goal, { signal })
        check(signal)
        return { kind: 'solve', result }
      }
      case 'repair':
        return {
          kind: 'repair',
          result: await drive(repairJob(recording, request.request), signal),
        }
      case 'sweep': {
        const { time, target, values } = request
        const sweep = await sweepAsync(recording, time, target, values, { signal })
        check(signal)
        return {
          kind: 'sweep',
          sweep: {
            runs: sweep.runs.map((run) => sweepRunSummary(recording, run.value, run.recording)),
            failed: sweep.failed,
          },
        }
      }
    }
  },
}
