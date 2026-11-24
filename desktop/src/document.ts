/**
 * The window's document: its title, and the rules for closing it with unsaved changes. The studio
 * reports the document's name and whether it is dirty (setDocument); closing a dirty window asks
 * Save / Don't Save / Cancel, and Save closes only once the studio's save has succeeded and the
 * studio reports the document clean.
 *
 * The close rules are a pure state machine (closeStep) so that every path through the prompt is
 * tested without a window; the glue only carries out the effects.
 */
import { basename } from 'node:path'
import type { DesktopDocumentState } from '../../src/studio/desktop/bridge'
import { APP_NAME } from './identity'

/** Marks a document with unsaved changes in the title, as many editors do. */
export const UNSAVED_MARK = '●'

/** `fib.sight — Hindsight`, `● fib.sight — Hindsight` with unsaved changes, or just `Hindsight`. */
export function windowTitle(state: DesktopDocumentState): string {
  if (state.name === null) return APP_NAME
  return `${state.dirty ? `${UNSAVED_MARK} ` : ''}${state.name} — ${APP_NAME}`
}

/**
 * The file macOS shows in the title bar's proxy icon: the last file the app opened or saved, when
 * the studio's document is still that file; otherwise none ('').
 */
export function representedFilename(name: string | null, knownPath: string | null): string {
  return name !== null && knownPath !== null && basename(knownPath) === name ? knownPath : ''
}

// --- closing with unsaved changes ------------------------------------------------------------

/**
 * How long the app waits, after Save is chosen in a prompt, for the studio's save to be done. The
 * studio starts saving at once; past the limit the window stays open (and a quit in progress
 * stops), so a save that never comes leaves no window waiting to close, and a later, unrelated
 * save does not close it.
 */
export const SAVE_AND_CLOSE_WINDOW_MS = 10_000

export type PromptAnswer = 'save' | 'discard' | 'cancel'

/** The unsaved-changes prompt's text and buttons, in the order each system's users expect. */
export interface ClosePrompt {
  readonly message: string
  readonly detail: string
  readonly buttons: readonly string[]
  /** The answer of each button. */
  readonly answers: readonly PromptAnswer[]
  readonly defaultId: number
  readonly cancelId: number
}

export function closePrompt(name: string | null, platform: string): ClosePrompt {
  const message = `Do you want to save the changes you made to ${name ?? 'this program'}?`
  const detail = "Your changes will be lost if you don't save them."
  // macOS lays buttons out right to left: Save rightmost, Cancel beside it, Don't Save apart.
  const answers: readonly PromptAnswer[] =
    platform === 'darwin' ? ['save', 'cancel', 'discard'] : ['save', 'discard', 'cancel']
  const labels: Readonly<Record<PromptAnswer, string>> = {
    save: 'Save',
    discard: "Don't Save",
    cancel: 'Cancel',
  }
  return {
    message,
    detail,
    buttons: answers.map((answer) => labels[answer]),
    answers,
    defaultId: answers.indexOf('save'),
    cancelId: answers.indexOf('cancel'),
  }
}

/** Asked before a reload would throw unsaved changes away; button 0 reloads. */
export function reloadPrompt(name: string | null): Omit<ClosePrompt, 'answers'> {
  return {
    message: `Reload ${APP_NAME}?`,
    detail: `Your unsaved changes to ${name ?? 'this program'} will be lost.`,
    buttons: ['Reload', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  }
}

/** The answer for the button the user pressed (Cancel for anything unexpected). */
export function answerOf(prompt: ClosePrompt, response: number): PromptAnswer {
  return prompt.answers[response] ?? 'cancel'
}

export interface CloseState {
  readonly dirty: boolean
  /** The Save / Don't Save / Cancel prompt is open. */
  readonly prompting: boolean
  /** Save was chosen: the window closes only if its save is done before this time (ms). */
  readonly closeAfterSaveUntil: number | null
  /**
   * Since Save was chosen, a save has succeeded. The window closes once the studio also reports
   * the document clean: an older save that was already under way can finish first, and then the
   * newest edits are still unsaved (the studio reports them dirty until its own save is done).
   */
  readonly saved: boolean
  /** The window may now close without asking. */
  readonly closing: boolean
}

export const INITIAL_CLOSE_STATE: CloseState = {
  dirty: false,
  prompting: false,
  closeAfterSaveUntil: null,
  saved: false,
  closing: false,
}

export type CloseEvent =
  | { readonly type: 'document'; readonly dirty: boolean; readonly now: number }
  /**
   * The window is about to close (the close button, the menu, quitting). `replacing`: the prompt
   * before replacing the program is open, or its save is under way (replace-guard.ts).
   */
  | { readonly type: 'close-requested'; readonly now: number; readonly replacing?: boolean }
  | { readonly type: 'answer'; readonly answer: PromptAnswer; readonly now: number }
  | { readonly type: 'save-finished'; readonly ok: boolean; readonly now: number }
  /** The time limit of a save-and-close has come (a timer set when Save was chosen). */
  | { readonly type: 'deadline'; readonly now: number }
  /** The page reloaded or crashed: what it reported no longer holds. */
  | { readonly type: 'page-reset' }

export type CloseEffect =
  /** Nothing to do (for close-requested: let the window close). */
  | 'none'
  /** Keep the window open (the close event is cancelled). */
  | 'prevent'
  /** Keep the window open and ask Save / Don't Save / Cancel. */
  | 'prompt'
  /** Ask the studio to save; the window closes when that save succeeds. */
  | 'save-and-close'
  /** Close the window now. */
  | 'close'
  /**
   * The window stays open: the user chose so, or the save they chose failed or never came, so a
   * pending quit is cancelled too. For close-requested, the close event is cancelled as well.
   */
  | 'stay'

export interface CloseStep {
  readonly state: CloseState
  readonly effect: CloseEffect
}

/** The window's close prompt is open, or the save it asked for is under way. */
export function closeBusy(state: CloseState): boolean {
  return state.prompting || state.closeAfterSaveUntil !== null
}

/**
 * Whether a page that went away (crashed, killed, or exited on its own) is offered a reload: yes,
 * unless the window is closing, when the page ends because the window does. Whatever the reason
 * Chromium gives: on Linux a killed page can report a clean exit, and the app never navigates
 * away from its own origin, so its page never legitimately ends while the window lives.
 */
export function offersReload(state: CloseState): boolean {
  return !state.closing
}

function expired(state: CloseState, now: number): boolean {
  return state.closeAfterSaveUntil !== null && now > state.closeAfterSaveUntil
}

/** A save-and-close that ended without closing: the window stays, and a quit in progress stops. */
function stay(state: CloseState): CloseStep {
  return { state: { ...state, closeAfterSaveUntil: null, saved: false }, effect: 'stay' }
}

function closeIfSavedAndClean(state: CloseState): CloseStep {
  if (!state.saved || state.dirty) return { state, effect: 'none' }
  return {
    state: { ...state, closeAfterSaveUntil: null, saved: false, closing: true },
    effect: 'close',
  }
}

function onCloseRequested(state: CloseState, now: number, replacing: boolean): CloseStep {
  if (state.closing) return { state, effect: 'none' }
  // The user is answering whether to save before something else replaces the program.
  if (replacing) return { state, effect: 'stay' }
  if (!state.dirty) return { state: { ...state, closing: true }, effect: 'none' }
  const saving = state.closeAfterSaveUntil !== null && !expired(state, now)
  if (state.prompting || saving) return { state, effect: 'prevent' }
  return {
    state: { ...state, prompting: true, closeAfterSaveUntil: null, saved: false },
    effect: 'prompt',
  }
}

function onAnswer(state: CloseState, answer: PromptAnswer, now: number): CloseStep {
  const answered = { ...state, prompting: false }
  if (answer === 'save')
    return {
      state: { ...answered, closeAfterSaveUntil: now + SAVE_AND_CLOSE_WINDOW_MS, saved: false },
      effect: 'save-and-close',
    }
  if (answer === 'discard') return { state: { ...answered, closing: true }, effect: 'close' }
  return { state: answered, effect: 'stay' }
}

function onSaveFinished(state: CloseState, ok: boolean, now: number): CloseStep {
  if (state.closeAfterSaveUntil === null) return { state, effect: 'none' }
  if (!ok || expired(state, now)) return stay(state)
  return closeIfSavedAndClean({ ...state, saved: true })
}

function onDocument(state: CloseState, dirty: boolean, now: number): CloseStep {
  const updated = { ...state, dirty }
  if (updated.closeAfterSaveUntil === null) return { state: updated, effect: 'none' }
  if (expired(updated, now)) return stay(updated)
  return closeIfSavedAndClean(updated)
}

function onPageReset(state: CloseState): CloseStep {
  const reset = { ...INITIAL_CLOSE_STATE, prompting: state.prompting }
  // A save-and-close under way is abandoned with the page that was saving.
  return { state: reset, effect: state.closeAfterSaveUntil === null ? 'none' : 'stay' }
}

export function closeStep(state: CloseState, event: CloseEvent): CloseStep {
  switch (event.type) {
    case 'document':
      return onDocument(state, event.dirty, event.now)
    case 'close-requested':
      return onCloseRequested(state, event.now, event.replacing === true)
    case 'answer':
      return onAnswer(state, event.answer, event.now)
    case 'save-finished':
      return onSaveFinished(state, event.ok, event.now)
    case 'deadline':
      return expired(state, event.now) ? stay(state) : { state, effect: 'none' }
    case 'page-reset':
      return onPageReset(state)
  }
}
