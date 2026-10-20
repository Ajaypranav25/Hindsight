/** The studio data the editor extensions read, pushed in from React with `setStudio`. */
import { Facet, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { closeHoverTooltips } from '@codemirror/view'
import type { Recording, StateView } from '../../core/index'
import type { StudioActions } from '../state/types'
import { mapBreakpointLines } from './breakpoint-map'
import { EMPTY_OVERLAY, type EditorOverlay } from './overlay'

export interface EditorStudio {
  readonly view: StateView | null
  readonly stale: boolean
  readonly selectedFrameUid: number | null
  readonly recording: Recording | null
  readonly time: number
  readonly breakpoints: ReadonlySet<number>
  readonly hitCounts: ReadonlyMap<number, number>
  readonly maxHits: number
  readonly overlay: EditorOverlay
}

export const EMPTY_STUDIO: EditorStudio = {
  view: null,
  stale: false,
  selectedFrameUid: null,
  recording: null,
  time: 0,
  breakpoints: new Set(),
  hitCounts: new Map(),
  maxHits: 0,
  overlay: EMPTY_OVERLAY,
}

interface FieldValue {
  readonly studio: EditorStudio
  /** The document changed since the last push, so positions no longer match the recording. */
  readonly dirty: boolean
}

export const setStudio = StateEffect.define<EditorStudio>()

export const studioField = StateField.define<FieldValue>({
  create: () => ({ studio: EMPTY_STUDIO, dirty: false }),
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setStudio)) return { studio: effect.value, dirty: false }
    if (!tr.docChanged) return value
    // Breakpoints follow their lines until the store (told by the editor) pushes them back.
    const breakpoints = mapBreakpointLines(
      value.studio.breakpoints,
      tr.startState.doc,
      tr.changes,
      tr.newDoc,
    )
    if (breakpoints === value.studio.breakpoints && value.dirty) return value
    return { studio: { ...value.studio, breakpoints }, dirty: true }
  },
})

/**
 * The effects that push `next` into the editor. A value hover shows the value at the pen, so it
 * closes when the pen, the recording or the selected frame changes (hovering again shows the new
 * value).
 */
export function studioEffects(state: EditorState, next: EditorStudio): StateEffect<unknown>[] {
  const previous = studioOf(state)
  const moved =
    previous.time !== next.time ||
    previous.recording !== next.recording ||
    previous.selectedFrameUid !== next.selectedFrameUid
  return moved ? [setStudio.of(next), closeHoverTooltips] : [setStudio.of(next)]
}

/** The store's actions, for gutter clicks and tooltip buttons. */
export const studioActions = Facet.define<StudioActions, StudioActions | null>({
  combine: (values) => values[0] ?? null,
})

/** Every pushed value, including stale ones (breakpoints are shown regardless). */
export function studioOf(state: EditorState): EditorStudio {
  return state.field(studioField).studio
}

/** The pushed value when it describes the current document and recording; otherwise null. */
export function liveStudio(state: EditorState): EditorStudio | null {
  const { studio, dirty } = state.field(studioField)
  return dirty || studio.stale || studio.recording === null ? null : studio
}
