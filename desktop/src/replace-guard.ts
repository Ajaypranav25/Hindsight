/**
 * Asking before the studio's program is replaced while it has unsaved changes. Opening a program,
 * a trace or a link (File > Open, a file or link handed to the app) and File > New each put a new
 * program in the editor. While the document is dirty, such a request first gets the Save / Don't
 * Save / Cancel prompt the close uses (closePrompt in document.ts):
 *
 * - Save asks the studio to save, and lets the requests through once a save has succeeded and the
 *   studio reports the document clean (as the close does, so an older save that finishes first
 *   does not count); a save that fails, is cancelled or never comes drops them.
 * - Don't Save lets them through; Cancel drops them.
 *
 * Requests that come while the prompt is open, or while its save runs, join the ones waiting. While
 * the window's own close prompt (or its save) is under way, requests wait for it to end: if the
 * window stays open they are asked about then; if it closes, they go with it.
 *
 * A pure state machine, like the close rules, so every path is tested without a window.
 */
import type { DesktopCommand } from '../../src/studio/desktop/bridge'
import { SAVE_AND_CLOSE_WINDOW_MS, type PromptAnswer } from './document'
import { MAX_QUEUED } from './ready-queue'

/** How long a Save chosen before replacing the program may take; then the requests are dropped. */
export const SAVE_BEFORE_REPLACING_MS = SAVE_AND_CLOSE_WINDOW_MS

/**
 * Menu commands that replace the program, and so are asked about like open requests. They also
 * wait for a page that is still loading, as open requests do; a save means nothing before then.
 */
export function replacesProgram(command: DesktopCommand): boolean {
  return command === 'new'
}

export type ReplacePhase =
  /** Nothing waits. */
  | 'idle'
  /** Requests wait for the window's close prompt, or the save it asked for, to end. */
  | 'held'
  /** The Save / Don't Save / Cancel prompt is open. */
  | 'prompting'
  /** Save was chosen: the requests wait for the save. */
  | 'saving'

export interface ReplaceState<T> {
  readonly dirty: boolean
  readonly phase: ReplacePhase
  /** The requests waiting, oldest first. */
  readonly waiting: readonly T[]
  /** While saving: the requests go through only if the save is done before this time (ms). */
  readonly saveUntil: number | null
  /** While saving: a save has succeeded since Save was chosen. */
  readonly saved: boolean
}

export const INITIAL_REPLACE_STATE: ReplaceState<never> = {
  dirty: false,
  phase: 'idle',
  waiting: [],
  saveUntil: null,
  saved: false,
}

export type ReplaceEvent<T> =
  | { readonly type: 'document'; readonly dirty: boolean; readonly now: number }
  /** A request to replace the program; `held` while the window's close prompt is under way. */
  | { readonly type: 'request'; readonly request: T; readonly held: boolean }
  | { readonly type: 'answer'; readonly answer: PromptAnswer; readonly now: number }
  | { readonly type: 'save-finished'; readonly ok: boolean; readonly now: number }
  /** The time limit of the save has come (a timer set when Save was chosen). */
  | { readonly type: 'deadline'; readonly now: number }
  /** The window's close prompt and its save are over, and the window stays open. */
  | { readonly type: 'resume' }
  /** The page reloaded or crashed: it has no document, so nothing is unsaved. */
  | { readonly type: 'page-reset'; readonly now: number }

export type ReplaceEffect<T> =
  | { readonly type: 'none' }
  /** Ask Save / Don't Save / Cancel. */
  | { readonly type: 'prompt' }
  /** Ask the studio to save its program. */
  | { readonly type: 'save' }
  /** Hand these requests to the studio, oldest first. */
  | { readonly type: 'deliver'; readonly requests: readonly T[] }

export interface ReplaceStep<T> {
  readonly state: ReplaceState<T>
  readonly effect: ReplaceEffect<T>
}

const NOTHING = { type: 'none' } as const

/** The prompt is open or its save is under way, so closing the window would cut across it. */
export function replacing(state: ReplaceState<unknown>): boolean {
  return state.phase === 'prompting' || state.phase === 'saving'
}

function settled<T>(state: ReplaceState<T>): ReplaceState<T> {
  return { ...state, phase: 'idle', waiting: [], saveUntil: null, saved: false }
}

function deliverAll<T>(state: ReplaceState<T>): ReplaceStep<T> {
  return { state: settled(state), effect: { type: 'deliver', requests: state.waiting } }
}

function dropAll<T>(state: ReplaceState<T>): ReplaceStep<T> {
  return { state: settled(state), effect: NOTHING }
}

function expired(state: ReplaceState<unknown>, now: number): boolean {
  return state.saveUntil !== null && now > state.saveUntil
}

function deliverIfSavedAndClean<T>(state: ReplaceState<T>): ReplaceStep<T> {
  return state.saved && !state.dirty ? deliverAll(state) : { state, effect: NOTHING }
}

function onRequest<T>(state: ReplaceState<T>, request: T, held: boolean): ReplaceStep<T> {
  if (state.phase !== 'idle') {
    const waiting = [...state.waiting, request].slice(-MAX_QUEUED)
    return { state: { ...state, waiting }, effect: NOTHING }
  }
  if (held) return { state: { ...state, phase: 'held', waiting: [request] }, effect: NOTHING }
  if (!state.dirty) return { state, effect: { type: 'deliver', requests: [request] } }
  return { state: { ...state, phase: 'prompting', waiting: [request] }, effect: { type: 'prompt' } }
}

function onAnswer<T>(state: ReplaceState<T>, answer: PromptAnswer, now: number): ReplaceStep<T> {
  if (state.phase !== 'prompting') return { state, effect: NOTHING }
  if (answer === 'discard') return deliverAll(state)
  if (answer === 'cancel') return dropAll(state)
  return {
    state: { ...state, phase: 'saving', saveUntil: now + SAVE_BEFORE_REPLACING_MS, saved: false },
    effect: { type: 'save' },
  }
}

function onSaveFinished<T>(state: ReplaceState<T>, ok: boolean, now: number): ReplaceStep<T> {
  if (state.phase !== 'saving') return { state, effect: NOTHING }
  if (!ok || expired(state, now)) return dropAll(state)
  return deliverIfSavedAndClean({ ...state, saved: true })
}

function onDocument<T>(state: ReplaceState<T>, dirty: boolean, now: number): ReplaceStep<T> {
  const updated = { ...state, dirty }
  if (updated.phase !== 'saving') return { state: updated, effect: NOTHING }
  if (expired(updated, now)) return dropAll(updated)
  return deliverIfSavedAndClean(updated)
}

function onResume<T>(state: ReplaceState<T>): ReplaceStep<T> {
  if (state.phase !== 'held') return { state, effect: NOTHING }
  if (!state.dirty) return deliverAll(state)
  return { state: { ...state, phase: 'prompting' }, effect: { type: 'prompt' } }
}

export function replaceStep<T>(state: ReplaceState<T>, event: ReplaceEvent<T>): ReplaceStep<T> {
  switch (event.type) {
    case 'document':
      return onDocument(state, event.dirty, event.now)
    case 'request':
      return onRequest(state, event.request, event.held)
    case 'answer':
      return onAnswer(state, event.answer, event.now)
    case 'save-finished':
      return onSaveFinished(state, event.ok, event.now)
    case 'deadline':
      return state.phase === 'saving' && expired(state, event.now)
        ? dropAll(state)
        : { state, effect: NOTHING }
    case 'resume':
      return onResume(state)
    case 'page-reset':
      return onDocument(state, false, event.now)
  }
}
