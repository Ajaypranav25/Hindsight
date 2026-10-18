import type { FrameView, StateView } from '../../core/api-types'
import type { StudioState } from './types'

/** True when the editor text differs from the program the recording was made from. */
export function isStale(state: StudioState): boolean {
  return state.recording !== null && state.recordedSource !== state.source
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
