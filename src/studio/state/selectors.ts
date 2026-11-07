import type { FrameView, StateView } from '../../core/api-types'
import type { StudioState } from './types'

/** True when the editor text differs from the program the recording was made from. */
export function isStale(state: StudioState): boolean {
  return state.recording !== null && state.recordedSource !== state.source
}

/**
 * The step a moment link carries: the pen's, when the shown recording is of the program in the
 * editor (null otherwise). A link replays the real run, so during a what-if it points no later
 * than the first edit, where the real run and the what-if are still the same.
 */
export function momentTime(state: StudioState): number | null {
  if (state.recording === null || isStale(state)) return null
  const firstEdit = state.whatIf?.edits[0]?.time
  return firstEdit === undefined ? state.time : Math.min(state.time, firstEdit)
}

/** The selected frame, or the innermost frame when none is selected (null when there are none). */
export function selectedFrame(
  view: StateView | null,
  selectedUid: number | null,
): FrameView | null {
  if (!view || view.frames.length === 0) return null
  const innermost = view.frames[view.frames.length - 1]!
  if (selectedUid === null) return innermost
  return view.frames.find((frame) => frame.uid === selectedUid) ?? innermost
}

/** The frames shown in the call stack, innermost first, optionally without library frames. */
export function visibleFrames(view: StateView | null, justMyCode: boolean): readonly FrameView[] {
  if (!view) return []
  const frames = [...view.frames].reverse()
  return justMyCode ? frames.filter((frame) => !frame.library) : frames
}

/** Diagnostics to show in the editor: the latest compile's, if it failed. */
export function currentDiagnostics(state: StudioState) {
  return state.compile && !state.compile.ok ? state.compile.diagnostics : []
}
