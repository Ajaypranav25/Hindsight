/**
 * The analyses the studio runs off the main thread (ARCHITECTURE §11.7), shared by the worker and
 * by the main-thread fallback. Searches are generators that pause after every fork or mutant, so
 * whoever drives them can stop between two units of work.
 */
import {
  backwardSlice,
  compareRecordings,
  type EditValue,
  type ForkError,
  type InverseGoal,
  type InverseResult,
  inverseSearch,
  MAX_SWEEP_VALUES,
  type ProvenanceEvent,
  queryRecording,
  type QueryOutcome,
  type Recording,
  type RepairRequest,
  type RepairResult,
  repairSearch,
  upstreamWrites,
  type WriteTarget,
} from '../../core/index'
import {
  type AnalysisRequest,
  type AnalysisResult,
  type CausalLink,
  MAX_CHAIN,
  type SliceSummary,
  type SweepRunSummary,
  type SweepSummary,
} from './protocol'
import { insightJob } from '../insight/compute'

/** The longest value text a causal link shows. */
const LINK_VALUE_CHARS = 24

/** The backward slice of step `at` with its causal chain; null when the run is too long. */
export function sliceSummary(recording: Recording, at: number): SliceSummary | null {
  const step = Math.max(0, Math.min(Math.trunc(at), recording.length))
  const slice = backwardSlice(recording, step)
  if (slice === null) return null
  const named = upstreamWrites(recording, slice).filter((write) => write.name !== null)
  const chain: CausalLink[] = []
  for (let i = named.length - 1; i >= 0 && chain.length < MAX_CHAIN; i--) {
    const write = named[i]!
    chain.push({
      time: write.event.time,
      name: write.name!,
      value: linkValue(recording, write.event),
      line: write.line,
    })
  }
  const location = recording.locationAt(step)
  return {
    at: step,
    lines: [...slice.lines].sort((a, b) => a - b),
    marks: slice.marks,
    steps: slice.steps,
    chain,
    chainTotal: named.length,
    effectLine: location !== null && location.source === 'main' ? location.line : null,
  }
}

/** `72`, `"free shipping"`, `nil`, `a list`. */
function linkValue(recording: Recording, event: ProvenanceEvent): string {
  const { value } = event
  if (value === null) return 'nil'
  if (typeof value === 'string') {
    const text = JSON.stringify(value)
    return text.length > LINK_VALUE_CHARS ? `${text.slice(0, LINK_VALUE_CHARS - 2)}…"` : text
  }
  if (typeof value !== 'object') return String(value)
  const object = recording.objectAt(Math.min(event.time + 1, recording.length), value.ref)
  if (object === null) return 'an object'
  return object.type === 'iterator' ? 'an iterator' : `a ${object.type}`
}

export function queryOutcome(recording: Recording, text: string, limit: number): QueryOutcome {
  return queryRecording(recording, text, { limit })
}

/** A search the driver advances one fork or mutant at a time. */
export type Job<T> = Generator<unknown, T, void>

/** The inverse what-if with synchronous forks, pausing after each. */
export function* solveJob(recording: Recording, goal: InverseGoal): Job<InverseResult> {
  const search = inverseSearch(recording, goal)
  let next = search.next()
  while (next.done !== true) {
    const { time, edit, maxSteps } = next.value
    const fork = recording.fork(time, edit, { maxSteps })
    yield
    next = search.next(fork)
  }
  return next.value
}

export function repairJob(recording: Recording, request: RepairRequest): Job<RepairResult> {
  return repairSearch(recording, request)
}

/** One fork per value; the runs are returned without their recordings. */
export function* sweepJob(
  recording: Recording,
  time: number,
  target: WriteTarget,
  values: readonly EditValue[],
): Job<SweepSummary> {
  const runs: SweepRunSummary[] = []
  const failed: { value: EditValue; error: ForkError }[] = []
  for (const value of values.slice(0, MAX_SWEEP_VALUES)) {
    const fork = recording.fork(time, { target, value })
    if (fork.ok) runs.push(sweepRunSummary(recording, value, fork.recording))
    else failed.push({ value, error: fork.error })
    yield
  }
  return { runs, failed }
}

export function sweepRunSummary(
  base: Recording,
  value: EditValue,
  run: Recording,
): SweepRunSummary {
  // A copy: the recording's own series must stay intact, and the copy can be transferred.
  const depths = run.depthSeries().slice()
  let maxDepth = 0
  for (const depth of depths) if (depth > maxDepth) maxDepth = depth
  return {
    value,
    length: run.length,
    outcome: run.outcome,
    comparison: compareRecordings(base, run),
    maxDepth,
    depths,
  }
}

/** The job that answers `request` about `recording`. */
export function analysisJob(recording: Recording, request: AnalysisRequest): Job<AnalysisResult> {
  switch (request.kind) {
    case 'slice':
      return lazy(() => ({ kind: 'slice', slice: sliceSummary(recording, request.at) }))
    case 'query':
      return lazy(() => ({
        kind: 'query',
        outcome: queryOutcome(recording, request.text, request.limit),
      }))
    case 'solve':
      return mapJob(solveJob(recording, request.goal), (result) => ({ kind: 'solve', result }))
    case 'repair':
      return mapJob(repairJob(recording, request.request), (result) => ({
        kind: 'repair',
        result,
      }))
    case 'sweep':
      return mapJob(sweepJob(recording, request.time, request.target, request.values), (sweep) => ({
        kind: 'sweep',
        sweep,
      }))
    case 'profile':
    case 'infer':
    case 'runDiff':
      return lazy(() => insightJob(recording, request))
  }
}

/** A single pass: the work happens when the job is first advanced. */
// eslint-disable-next-line require-yield
function* lazy<T>(compute: () => T): Job<T> {
  return compute()
}

function* mapJob<T, U>(job: Job<T>, map: (value: T) => U): Job<U> {
  return map(yield* job)
}

/** Runs a job to its end without pausing. */
export function runJob<T>(job: Job<T>): T {
  let next = job.next()
  while (next.done !== true) next = job.next()
  return next.value
}
