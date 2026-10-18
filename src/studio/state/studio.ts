import { useMemo } from 'react'
import { useStore } from 'zustand'
import type { FrameView, StateView } from '../../core/api-types'
import { compile, recordAsync } from '../../core/index'
import { EXAMPLES } from '../examples'
import { sourceFromFragment } from '../lib/share'
import { browserStorage } from '../lib/storage'
import { browserScheduler } from './scheduler'
import { selectedFrame } from './selectors'
import { createStudioStore } from './store'
import type { Engine, StudioActions, StudioStore } from './types'

const engine: Engine = { compile, recordAsync }

function sharedSourceFromLocation(): string | null {
  try {
    return sourceFromFragment(globalThis.location?.hash ?? '')
  } catch {
    return null
  }
}

/** The studio's single store. */
export const studioStore = createStudioStore(
  { engine, storage: browserStorage(), scheduler: browserScheduler, examples: EXAMPLES },
  { sharedSource: sharedSourceFromLocation() },
)

/** The store's actions. They never change identity, so components call them directly. */
export const studioActions: StudioActions = (() => {
  const s = studioStore.getState()
  return {
    setSource: s.setSource,
    loadExample: s.loadExample,
    run: s.run,
    extend: s.extend,
    seek: s.seek,
    stepNav: s.stepNav,
    continueNav: s.continueNav,
    stepInstruction: s.stepInstruction,
    jumpToStart: s.jumpToStart,
    jumpToEnd: s.jumpToEnd,
    togglePlay: s.togglePlay,
    stopPlay: s.stopPlay,
    toggleBreakpoint: s.toggleBreakpoint,
    selectFrame: s.selectFrame,
    jumpToOrigin: s.jumpToOrigin,
    setWatch: s.setWatch,
    updateSettings: s.updateSettings,
    dismissHint: s.dismissHint,
    clearNotice: s.clearNotice,
  }
})()

/** Reads a slice of studio state; re-renders only when the slice changes (by `Object.is`). */
export function useStudio<T>(selector: (state: StudioStore) => T): T {
  return useStore(studioStore, selector)
}

/** The program state at the pen (null before the first recording). */
export function useStateView(): StateView | null {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  return useMemo(() => (recording ? recording.stateAt(time) : null), [recording, time])
}

/** The selected frame (the innermost one unless the user picked another). */
export function useSelectedFrame(): FrameView | null {
  const view = useStateView()
  const uid = useStudio((s) => s.selectedFrameUid)
  return useMemo(() => selectedFrame(view, uid), [view, uid])
}
