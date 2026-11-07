/**
 * The studio side of the bug finder (ARCHITECTURE §7.6, §11.3): the interview kept in the store
 * and the actions that change it. An interview belongs to one recording; once a new run replaces
 * that recording, the interview is over (`liveSession`), so nothing needs resetting on a run.
 */
import type { StoreApi } from 'zustand/vanilla'
import {
  answer,
  type Answer,
  callTree,
  type FinderState,
  type Recording,
  startFinder,
  undo,
} from '../../core/index'
import type { StudioActions, StudioStore } from './types'

export interface BugFinderSession {
  /** The recording the interview is about. */
  readonly recording: Recording
  readonly finder: FinderState
}

export interface BugFinderState {
  /** Bumped each time the bug finder is opened from outside its panel, so the layout reveals it. */
  readonly reveal: number
  /**
   * The last reveal the panel moved focus for. Behind `reveal` until the shown panel takes focus,
   * which may be a panel that only mounts because of the reveal.
   */
  readonly focused: number
  /** The interview, or null. */
  readonly session: BugFinderSession | null
}

export const INITIAL_BUG_FINDER: BugFinderState = { reveal: 0, focused: 0, session: null }

/** The interview in progress about `recording`, or null. */
export function liveSession(
  state: BugFinderState,
  recording: Recording | null,
): BugFinderSession | null {
  const session = state.session
  return session !== null && recording !== null && session.recording === recording ? session : null
}

/** A new interview below the call that begins at step `entry` (the whole program by default). */
export function startSession(
  recording: Recording,
  justMyCode: boolean,
  entry?: number,
): BugFinderSession | null {
  const tree = callTree(recording)
  const from = entry === undefined ? tree.root : tree.call(entry)
  if (from === null) return null
  return { recording, finder: startFinder(tree, from, { justMyCode }) }
}

type BugFinderActions = Pick<
  StudioActions,
  | 'openBugFinder'
  | 'markBugFinderFocused'
  | 'startBugFinder'
  | 'answerBugFinder'
  | 'undoBugFinder'
  | 'closeBugFinder'
>

/** The store's bug-finder actions. */
export function bugFinderActions(
  get: StoreApi<StudioStore>['getState'],
  set: StoreApi<StudioStore>['setState'],
): BugFinderActions {
  const update = (change: (finder: FinderState) => FinderState) => {
    const { bugFinder, recording } = get()
    const session = liveSession(bugFinder, recording)
    if (session === null) return
    const finder = change(session.finder)
    if (finder !== session.finder)
      set({ bugFinder: { ...bugFinder, session: { ...session, finder } } })
  }
  const start = (entry?: number) => {
    const { bugFinder, recording, settings, source, recordedSource } = get()
    // An interview about a recording older than the program would ask about code that is gone.
    if (recording === null || recordedSource !== source) return
    const session = startSession(recording, settings.justMyCode, entry)
    if (session !== null) set({ bugFinder: { ...bugFinder, session } })
  }
  return {
    openBugFinder() {
      const { bugFinder, recording, whatIf } = get()
      set({ bugFinder: { ...bugFinder, reveal: bugFinder.reveal + 1 } })
      // An interview about the real run outlives a what-if: going back continues it.
      if (whatIf !== null && bugFinder.session?.recording === whatIf.parent) return
      const failed = recording?.outcome.kind === 'error'
      if (!failed && liveSession(bugFinder, recording) === null) start()
    },
    markBugFinderFocused() {
      const { bugFinder } = get()
      if (bugFinder.focused !== bugFinder.reveal) {
        set({ bugFinder: { ...bugFinder, focused: bugFinder.reveal } })
      }
    },
    startBugFinder: start,
    answerBugFinder: (given: Answer) => update((finder) => answer(finder, given)),
    undoBugFinder: () => update(undo),
    closeBugFinder() {
      const { bugFinder } = get()
      if (bugFinder.session !== null) set({ bugFinder: { ...bugFinder, session: null } })
    },
  }
}
