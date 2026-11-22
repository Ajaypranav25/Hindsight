/**
 * The insight analyses' part of the analysis protocol (ARCHITECTURE §11.7): the step profile for
 * the Profile panel, contract inference for "Suggest contracts" and the behaviour diff shown after
 * an edit. Results are plain data that survive `structuredClone`; the profile's stack-path tree is
 * sent flat (a deep tree would make the clone recurse as deep as the program did).
 */
import type {
  ChangedCall,
  FunctionProfile,
  InferResult,
  LineProfile,
  OriginGroup,
  OutputDiffLine,
} from '../../core/index'
import type { RunDescription } from '../analysis/protocol'

/** One stack path of the flame chart, in pre-order. */
export interface FlameNode {
  /** `fib`, `lambda@12`, `<top level>`. */
  readonly label: string
  /** 0 for the top level. */
  readonly depth: number
  /** Its left edge: the steps of the paths before it under the same parent, plus the parent's. */
  readonly offset: number
  readonly inclusive: number
  readonly self: number
  readonly calls: number
  /** The first step of the first call on this path. */
  readonly firstEntry: number
  readonly library: boolean
  /** Index of the parent path; -1 for the top level. */
  readonly parent: number
}

export interface ProfileSummary {
  readonly steps: number
  readonly justMyCode: boolean
  /** The heaviest functions (by inclusive steps), at most `MAX_PROFILE_FUNCTIONS`. */
  readonly functions: readonly FunctionProfile[]
  readonly functionsTotal: number
  /** The busiest lines, at most `MAX_PROFILE_LINES`. */
  readonly lines: readonly LineProfile[]
  /** The stack paths wide enough to draw, at most `MAX_FLAME_NODES`, parents first. */
  readonly flame: readonly FlameNode[]
  /** Paths left out because they were too narrow to see or over the cap. */
  readonly flameOmitted: number
}

/** What changed in behaviour between the run before an edit and the run after it. */
export interface EditDiffSummary {
  readonly same: boolean
  readonly sameOutcome: boolean
  /** Output lines only the old run printed, and only the new one. */
  readonly removed: number
  readonly added: number
  /** The changed output lines (removed and added), at most `limit`. */
  readonly outputLines: readonly OutputDiffLine[]
  readonly origins: readonly OriginGroup[]
  readonly originsTotal: number
  readonly changed: readonly ChangedCall[]
  readonly changedTotal: number
  /** Calls only one of the runs made (top-most ones). */
  readonly onlyOld: number
  readonly onlyNew: number
  /** The alignment or the comparison ran out of budget: the lists may be incomplete. */
  readonly truncated: boolean
}

export type InsightRequest =
  | { readonly kind: 'profile'; readonly justMyCode: boolean }
  /** Contract inference for the `fn` named `fn` (every function when null). */
  | { readonly kind: 'infer'; readonly fn: string | null }
  /** The shown run (the new one) against `previous`, the run before the edit. */
  | { readonly kind: 'runDiff'; readonly previous: RunDescription; readonly limit: number }

export type InsightResult =
  | { readonly kind: 'profile'; readonly profile: ProfileSummary }
  | { readonly kind: 'infer'; readonly result: InferResult }
  /** null when the previous run could not be recorded again. */
  | { readonly kind: 'runDiff'; readonly diff: EditDiffSummary | null }

export const MAX_PROFILE_FUNCTIONS = 200
export const MAX_PROFILE_LINES = 50
export const MAX_FLAME_NODES = 20_000
/** A path narrower than this share of the run is invisible at any width, so it is left out. */
export const MIN_FLAME_SHARE = 1 / 8000
