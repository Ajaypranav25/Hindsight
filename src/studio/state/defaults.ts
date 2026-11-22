import type { Recording } from '../../core/api-types'
import { DEFAULT_QUANTUM, DEFAULT_SCHEDULE_SEED, type ScheduleOptions } from '../../core/api-types'
import type { PenPosition, Settings, StudioSchedule } from './types'

export const STEP_BUDGETS = [500_000, 2_000_000, 10_000_000] as const

export const DEFAULT_SETTINGS: Settings = {
  maxSteps: 2_000_000,
  justMyCode: true,
  autoRun: true,
  instructionLevel: false,
  theme: 'system',
  playbackSpeed: 8,
  keepPlace: true,
  schedule: { policy: 'round-robin', seed: DEFAULT_SCHEDULE_SEED, quantum: DEFAULT_QUANTUM },
}

/** The largest schedule seed and quantum the settings accept. */
export const MAX_SCHEDULE_SEED = 0xffffffff
export const MAX_SETTINGS_QUANTUM = 1000

/** The core's schedule for the setting: undefined for round-robin (the default). */
export function scheduleOptions(schedule: StudioSchedule): ScheduleOptions | undefined {
  if (schedule.policy !== 'random') return undefined
  return { policy: 'random', seed: schedule.seed, quantum: schedule.quantum }
}

function isSchedule(value: unknown): value is StudioSchedule {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.policy === 'round-robin' || v.policy === 'random') &&
    Number.isInteger(v.seed) &&
    (v.seed as number) >= 0 &&
    (v.seed as number) <= MAX_SCHEDULE_SEED &&
    Number.isInteger(v.quantum) &&
    (v.quantum as number) >= 1 &&
    (v.quantum as number) <= MAX_SETTINGS_QUANTUM
  )
}

/**
 * Stored settings with their defaults filled in: settings saved before a field existed keep the
 * rest; null when a stored field is invalid.
 */
export function storedSettings(value: unknown): Settings | null {
  if (typeof value !== 'object' || value === null) return null
  const merged = { ...DEFAULT_SETTINGS, ...(value as object) }
  return isSettings(merged) ? merged : null
}

export const AUTO_RUN_DELAY_MS = 600
export const PERSIST_DELAY_MS = 400
export const NOTICE_DURATION_MS = 6000
/** Notices that offer a button stay longer, so there is time to use it. */
export const ACTION_NOTICE_DURATION_MS = 15_000

export const STORAGE_KEYS = {
  source: 'hindsight:source',
  /** The user's own program, kept when a share link or an example replaced it. */
  previousSource: 'hindsight:previous-source',
  /** Present while the stored program arrived with a link or an example and was not edited. */
  sourceDelivered: 'hindsight:source-delivered',
  settings: 'hindsight:settings',
  hintDismissed: 'hindsight:hint-dismissed',
  /**
   * Set while a recording runs and until it has been displayed; still set on load means that run
   * froze or crashed the tab.
   */
  runInProgress: 'hindsight:run-in-progress',
} as const

/**
 * Accepts stored settings only when every field has the right type and a sane value. Settings
 * added later may be missing from older stored settings (`storedSettings` fills them in first).
 */
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
    v.playbackSpeed <= 60 &&
    typeof v.keepPlace === 'boolean' &&
    isSchedule(v.schedule)
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
