import { readJson } from '../lib/storage'
import { DEFAULT_SETTINGS, isSettings, STORAGE_KEYS } from './defaults'
import type { Example, KeyValueStorage, StudioState } from './types'

export interface Startup {
  /** A program carried by a share link, if the page was opened with one. */
  readonly sharedSource: string | null
}

const FALLBACK_SOURCE = 'print("Hello, Hindsight!")\n'

export const UNFINISHED_RUN_NOTICE = 'The last run did not finish. Press Run to try again.'

/** True when the previous page's recording never completed (it froze or crashed the tab). */
export function lastRunUnfinished(storage: KeyValueStorage): boolean {
  return storage.read(STORAGE_KEYS.runInProgress) !== null
}

/** Chooses the opening program: a shared link wins, then the last session, then the first example. */
export function initialState(
  storage: KeyValueStorage,
  examples: readonly Example[],
  startup: Startup,
): StudioState {
  const stored = storage.read(STORAGE_KEYS.source)
  const first = examples[0] ?? null
  const source = startup.sharedSource ?? stored ?? first?.source ?? FALLBACK_SOURCE
  const exampleId = examples.find((example) => example.source === source)?.id ?? null
  return {
    source,
    exampleId,
    compile: null,
    recording: null,
    recordedSource: null,
    status: { kind: 'idle' },
    time: 0,
    selectedFrameUid: null,
    breakpoints: new Set<number>(),
    watch: null,
    playing: false,
    settings: readJson(storage, STORAGE_KEYS.settings, isSettings) ?? DEFAULT_SETTINGS,
    hintDismissed: storage.read(STORAGE_KEYS.hintDismissed) === 'true',
    notice: lastRunUnfinished(storage) ? { text: UNFINISHED_RUN_NOTICE, tone: 'error' } : null,
    originMark: null,
  }
}
