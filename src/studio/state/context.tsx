import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useStore, type StoreApi } from 'zustand'
import type { FrameView, StateView } from '../../core/api-types'
import { selectedFrame } from './selectors'
import type { StudioActions, StudioStore } from './types'

const StudioContext = createContext<StoreApi<StudioStore> | null>(null)

/** Provides the studio store to every component below it (tests pass their own store). */
export function StudioProvider(props: { store: StoreApi<StudioStore>; children: ReactNode }) {
  return <StudioContext.Provider value={props.store}>{props.children}</StudioContext.Provider>
}

function useStudioStore(): StoreApi<StudioStore> {
  const store = useContext(StudioContext)
  if (!store) throw new Error('useStudio must be used inside <StudioProvider>')
  return store
}

/** Reads a slice of studio state; re-renders only when the slice changes (by `Object.is`). */
export function useStudio<T>(selector: (state: StudioStore) => T): T {
  return useStore(useStudioStore(), selector)
}

/** The store's actions. Their identities never change. */
export function useStudioActions(): StudioActions {
  const store = useStudioStore()
  return useMemo(() => pickActions(store.getState()), [store])
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

export function pickActions(s: StudioStore): StudioActions {
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
}
