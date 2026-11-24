/**
 * The window's document: its title, and the rules for closing it with unsaved changes. The studio
 * reports the document's name and whether it is dirty (setDocument); closing a dirty window asks
 * Save / Don't Save / Cancel, and Save closes only once the studio's save has succeeded.
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
 * How long the app waits, after asking the studio to save and close, for that save to arrive.
 * The studio starts saving at once; the limit only stops a later, unrelated save from closing
 * the window if the studio never answered.
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

/** The answer for the button the user pressed (Cancel for anything unexpected). */
export function answerOf(prompt: ClosePrompt, response: number): PromptAnswer {
  return prompt.answers[response] ?? 'cancel'
}

export interface CloseState {
  readonly dirty: boolean
  /** The Save / Don't Save / Cancel prompt is open. */
  readonly prompting: boolean
  /** Close once a save finishes before this time (ms); null when no save-and-close is pending. */
  readonly closeAfterSaveUntil: number | null
  /** The window may now close without asking. */
  readonly closing: boolean
}

export const INITIAL_CLOSE_STATE: CloseState = {
  dirty: false,
  prompting: false,
  closeAfterSaveUntil: null,
  closing: false,
}

export type CloseEvent =
  | { readonly type: 'document'; readonly dirty: boolean }
  /** The window is about to close (the close button, the menu, quitting). */
  | { readonly type: 'close-requested'; readonly now: number }
  | { readonly type: 'answer'; readonly answer: PromptAnswer; readonly now: number }
  | { readonly type: 'save-finished'; readonly ok: boolean; readonly now: number }
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
  /** The user chose to keep the window open: a pending quit is cancelled too. */
  | 'stay'

export interface CloseStep {
  readonly state: CloseState
  readonly effect: CloseEffect
}

function onCloseRequested(state: CloseState, now: number): CloseStep {
  if (state.closing || !state.dirty) return { state: { ...state, closing: true }, effect: 'none' }
  const saving = state.closeAfterSaveUntil !== null && now <= state.closeAfterSaveUntil
  if (state.prompting || saving) return { state, effect: 'prevent' }
  return { state: { ...state, prompting: true, closeAfterSaveUntil: null }, effect: 'prompt' }
}

function onAnswer(state: CloseState, answer: PromptAnswer, now: number): CloseStep {
  const answered = { ...state, prompting: false }
  if (answer === 'save')
    return {
      state: { ...answered, closeAfterSaveUntil: now + SAVE_AND_CLOSE_WINDOW_MS },
      effect: 'save-and-close',
    }
  if (answer === 'discard') return { state: { ...answered, closing: true }, effect: 'close' }
  return { state: answered, effect: 'stay' }
}

function onSaveFinished(state: CloseState, ok: boolean, now: number): CloseStep {
  const deadline = state.closeAfterSaveUntil
  if (deadline === null) return { state, effect: 'none' }
  const settled = { ...state, closeAfterSaveUntil: null }
  if (!ok || now > deadline) return { state: settled, effect: ok ? 'none' : 'stay' }
  return { state: { ...settled, dirty: false, closing: true }, effect: 'close' }
}

export function closeStep(state: CloseState, event: CloseEvent): CloseStep {
  switch (event.type) {
    case 'document':
      return { state: { ...state, dirty: event.dirty }, effect: 'none' }
    case 'close-requested':
      return onCloseRequested(state, event.now)
    case 'answer':
      return onAnswer(state, event.answer, event.now)
    case 'save-finished':
      return onSaveFinished(state, event.ok, event.now)
    case 'page-reset':
      return { state: { ...INITIAL_CLOSE_STATE, prompting: state.prompting }, effect: 'none' }
  }
}
