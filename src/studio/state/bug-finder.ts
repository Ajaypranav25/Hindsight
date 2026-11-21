/**
 * The studio side of the bug finder (ARCHITECTURE §7.6, §11.3): the interview kept in the store
 * and the actions that change it. An interview belongs to one recording; once a new run replaces
 * that recording, the interview is over (`liveSession`), so nothing needs resetting on a run.
 * Unless the user turns it off, the program's contracts and assertions answer what they can
 * (`contractOracle`) after every change, so an interview can reach its verdict with no questions.
 */
import type { StoreApi } from 'zustand/vanilla'
import {
  answer,
  type Answer,
  autoAnswer,
  type CallOracle,
  callTree,
  contractOracle,
  type FinderState,
  type Recording,
  startFinder,
  type Strategy,
  undo,
} from '../../core/index'
import type { StudioActions, StudioStore } from './types'

export interface BugFinderSession {
  /** The recording the interview is about. */
  readonly recording: Recording
  readonly finder: FinderState
  /** Answers from the program's contracts and assertions; null when the user turned them off. */
  readonly oracle: CallOracle | null
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
  /**
   * How new interviews choose their questions: `divide` halves the suspects with each answer,
   * `top-down` asks in call order.
   */
  readonly strategy: Strategy
  /** Whether new interviews let contracts and assertions answer questions ("Use contracts and assertions"). */
  readonly auto: boolean
}

export const INITIAL_BUG_FINDER: BugFinderState = {
  reveal: 0,
  focused: 0,
  session: null,
  strategy: 'divide',
  auto: true,
}

/** Runtime errors that are a broken promise: a failed assertion, precondition or postcondition. */
const CHECK_FAILURES: ReadonlySet<string> = new Set(['R018', 'R026', 'R027'])

/** Whether the run failed an assertion or a contract (the bug finder can start from that). */
export function failedCheck(recording: Recording): boolean {
  const { outcome } = recording
  return outcome.kind === 'error' && CHECK_FAILURES.has(outcome.error.code)
}

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
  strategy: Strategy = 'top-down',
  auto = false,
): BugFinderSession | null {
  const tree = callTree(recording)
  const from = entry === undefined ? tree.root : tree.call(entry)
  if (from === null) return null
  const oracle = auto ? contractOracle(recording, tree) : null
  const started = startFinder(tree, from, { justMyCode, strategy })
  return { recording, finder: oracle === null ? started : autoAnswer(started, oracle), oracle }
}

/** The session after the user's answer, with what the oracle can answer next. */
export function answerSession(session: BugFinderSession, given: Answer): BugFinderSession {
  const answered = answer(session.finder, given)
  const finder = session.oracle === null ? answered : autoAnswer(answered, session.oracle)
  return finder === session.finder ? session : { ...session, finder }
}

/**
 * The session before its last answer. Taking back an automatic answer leaves that question to the
 * user (`undo` declines it), so the oracle is not asked again here.
 */
export function undoSession(session: BugFinderSession): BugFinderSession {
  const finder = undo(session.finder)
  return finder === session.finder ? session : { ...session, finder }
}

type BugFinderActions = Pick<
  StudioActions,
  | 'openBugFinder'
  | 'markBugFinderFocused'
  | 'startBugFinder'
  | 'answerBugFinder'
  | 'undoBugFinder'
  | 'closeBugFinder'
  | 'setBugFinderStrategy'
  | 'setBugFinderAuto'
>

/** The store's bug-finder actions. */
export function bugFinderActions(
  get: StoreApi<StudioStore>['getState'],
  set: StoreApi<StudioStore>['setState'],
): BugFinderActions {
  const update = (change: (session: BugFinderSession) => BugFinderSession) => {
    const { bugFinder, recording } = get()
    const session = liveSession(bugFinder, recording)
    if (session === null) return
    const changed = change(session)
    if (changed !== session) set({ bugFinder: { ...bugFinder, session: changed } })
  }
  const start = (entry?: number) => {
    const { bugFinder, recording, settings, source, recordedSource } = get()
    // An interview about a recording older than the program would ask about code that is gone.
    if (recording === null || recordedSource !== source) return
    const { strategy, auto } = bugFinder
    const session = startSession(recording, settings.justMyCode, entry, strategy, auto)
    if (session !== null) set({ bugFinder: { ...bugFinder, session } })
  }
  return {
    openBugFinder() {
      const { bugFinder, recording, whatIf } = get()
      set({ bugFinder: { ...bugFinder, reveal: bugFinder.reveal + 1 } })
      // An interview about the real run outlives a what-if: going back continues it.
      if (whatIf !== null && bugFinder.session?.recording === whatIf.parent) return
      // A failed contract or assertion is where the search starts; other errors come first.
      const failed = recording !== null && recording.outcome.kind === 'error'
      const blocked = failed && !(bugFinder.auto && failedCheck(recording))
      if (!blocked && liveSession(bugFinder, recording) === null) start()
    },
    markBugFinderFocused() {
      const { bugFinder } = get()
      if (bugFinder.focused !== bugFinder.reveal) {
        set({ bugFinder: { ...bugFinder, focused: bugFinder.reveal } })
      }
    },
    startBugFinder: start,
    answerBugFinder: (given: Answer) => update((session) => answerSession(session, given)),
    undoBugFinder: () => update(undoSession),
    setBugFinderStrategy(strategy: Strategy) {
      const { bugFinder, recording } = get()
      if (bugFinder.strategy === strategy) return
      set({ bugFinder: { ...bugFinder, strategy } })
      // An open interview starts over from the same call, asked the new way.
      const session = liveSession(bugFinder, recording)
      if (session !== null) start(session.finder.start.id)
    },
    setBugFinderAuto(auto: boolean) {
      const { bugFinder, recording } = get()
      if (bugFinder.auto === auto) return
      set({ bugFinder: { ...bugFinder, auto } })
      // An open interview starts over from the same call, with or without automatic answers.
      const session = liveSession(bugFinder, recording)
      if (session !== null) start(session.finder.start.id)
    },
    closeBugFinder() {
      const { bugFinder } = get()
      if (bugFinder.session !== null) set({ bugFinder: { ...bugFinder, session: null } })
    },
  }
}
