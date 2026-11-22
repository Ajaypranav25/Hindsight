/**
 * The insight analyses (ARCHITECTURE §11.7), shared by the analysis worker and the main-thread
 * fallback: the step profile, contract inference and the behaviour diff after an edit, each
 * reduced to the plain data the studio shows.
 */
import {
  callTree,
  DEFAULT_SEED,
  diffRuns,
  inferContracts,
  type InferResult,
  profile,
  type Recording,
} from '../../core/index'
import { describeRun, recordingOf } from '../analysis/run-description'
import {
  type EditDiffSummary,
  type InsightRequest,
  type InsightResult,
  MAX_PROFILE_FUNCTIONS,
  MAX_PROFILE_LINES,
  type ProfileSummary,
} from './insight-protocol'
import { flattenFlame } from './profile-model'

/** The bounds of the diff after an edit: it runs while the user may be typing again. */
export const EDIT_DIFF_NODES = 20_000
export const EDIT_DIFF_COMPARED = 2_000

export function profileSummary(recording: Recording, justMyCode: boolean): ProfileSummary {
  const result = profile(recording, { justMyCode })
  const flame = flattenFlame(result.root)
  return {
    steps: result.steps,
    justMyCode,
    functions: result.functions.slice(0, MAX_PROFILE_FUNCTIONS),
    functionsTotal: result.functions.length,
    lines: result.lines.slice(0, MAX_PROFILE_LINES),
    flame: flame.nodes,
    flameOmitted: flame.omitted,
  }
}

/** Likely contracts for the `fn` named `fn` (all of them when null), checked by a re-run. */
export function inferSummary(recording: Recording, fn: string | null): InferResult {
  const seed = describeRun(recording)?.seed ?? DEFAULT_SEED
  return inferContracts(recording, callTree(recording), fn === null ? { seed } : { fn, seed })
}

/** `current` (the run after an edit) against `previous` (the run before it), bounded. */
export function editDiffSummary(
  previous: Recording,
  current: Recording,
  limit: number,
): EditDiffSummary {
  const diff = diffRuns(previous, current, {
    maxNodes: EDIT_DIFF_NODES,
    maxCompared: EDIT_DIFF_COMPARED,
    limit,
  })
  return {
    same: diff.same,
    sameOutcome: diff.sameOutcome,
    removed: diff.output.removed,
    added: diff.output.added,
    outputLines: diff.output.lines.filter((line) => line.kind !== 'same').slice(0, limit),
    origins: diff.origins.items,
    originsTotal: diff.origins.total,
    changed: diff.changed.items,
    changedTotal: diff.changed.total,
    onlyOld: diff.onlyA.total,
    onlyNew: diff.onlyB.total,
    truncated: diff.truncated.nodes || diff.truncated.compared,
  }
}

/** Answers an insight request about `recording` (a single pass, run to its end). */
export function insightJob(recording: Recording, request: InsightRequest): InsightResult {
  switch (request.kind) {
    case 'profile':
      return { kind: 'profile', profile: profileSummary(recording, request.justMyCode) }
    case 'infer':
      return { kind: 'infer', result: inferSummary(recording, request.fn) }
    case 'runDiff': {
      const previous = recordingOf(request.previous)
      const diff = previous === null ? null : editDiffSummary(previous, recording, request.limit)
      return { kind: 'runDiff', diff }
    }
  }
}
