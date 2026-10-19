import type { Recording } from '../../core/api-types'
import type { PenPosition, Settings } from './types'

export const STEP_BUDGETS = [500_000, 2_000_000, 10_000_000] as const

export const DEFAULT_SETTINGS: Settings = {
  maxSteps: 2_000_000,
  justMyCode: true,
  autoRun: true,
  instructionLevel: false,
  theme: 'system',
  playbackSpeed: 8,
}

export const AUTO_RUN_DELAY_MS = 600
export const PERSIST_DELAY_MS = 400
export const NOTICE_DURATION_MS = 6000

export const STORAGE_KEYS = {
  source: 'hindsight:source',
  settings: 'hindsight:settings',
  hintDismissed: 'hindsight:hint-dismissed',
} as const

/** Accepts stored settings only when every field has the right type and a sane value. */
export function isSettings(value: unknown): value is Settings {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.maxSteps === 'number' &&
    (STEP_BUDGETS as readonly number[]).includes(v.maxSteps) &&
    typeof v.justMyCode === 'boolean' &&
    typeof v.autoRun === 'boolean' &&
    typeof v.instructionLevel === 'boolean' &&
    (v.theme === 'system' || v.theme === 'light' || v.theme === 'dark') &&
    typeof v.playbackSpeed === 'number' &&
    v.playbackSpeed >= 1 &&
    v.playbackSpeed <= 60
  )
}

/**
 * Where to put the pen for a freshly loaded program: at the failure for runs that end in an error,
 * at the first moment of greatest call depth when there are calls (the top of the tallest peak),
 * otherwise at the end.
 */
export function interestingTime(recording: Recording): number {
  const n = recording.length
  if (recording.outcome.kind === 'error') return n
  const depths = recording.depthSeries()
  let best = 0
  let bestTime = n
  for (let t = 0; t < depths.length; t++) {
    if (depths[t]! > best) {
      best = depths[t]!
      bestTime = t
    }
  }
  return best === 0 ? n : bestTime
}

/** The pen's opening position for a recording, per an example's `// pen:` header. */
export function penTime(recording: Recording, pen: PenPosition): number {
  const n = recording.length
  if (recording.outcome.kind === 'error' || pen === 'peak') return interestingTime(recording)
  if (pen === 'start') return 0
  if (pen === 'end') return n
  return Math.round(Math.min(1, Math.max(0, pen)) * n)
}
