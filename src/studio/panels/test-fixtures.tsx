/** Hand-built state views, fake recordings and a store wrapper for the panel tests. */
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import type {
  FrameView,
  GlobalView,
  LocalKind,
  LocalView,
  Recording,
  StateView,
  ValueView,
} from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import { fakeRecording, scriptedEngine } from '../state/testing'

const SPAN = { start: 0, end: 1 }

export function localView(
  name: string,
  slot: number,
  value: ValueView,
  frameUid: number,
  kind: LocalKind = 'let',
): LocalView {
  return {
    name,
    slot,
    kind,
    mutable: kind === 'var',
    value,
    declSpan: SPAN,
    target: { kind: 'local', frameUid, slot },
  }
}

export function globalView(
  name: string,
  value: ValueView,
  kind: GlobalView['kind'] = 'let',
): GlobalView {
  return {
    name,
    kind,
    mutable: kind === 'var',
    value,
    declSpan: SPAN,
    target: { kind: 'global', name },
  }
}

export function frameView(patch: Partial<FrameView> & { uid: number }): FrameView {
  return {
    name: '<top level>',
    protoId: 0,
    ip: 0,
    library: false,
    source: 'main',
    span: SPAN,
    stmtSpan: SPAN,
    line: 1,
    locals: [],
    captures: [],
    temps: [],
    ...patch,
  }
}

export function stateView(patch: Partial<StateView> & { time: number }): StateView {
  return {
    location: null,
    frames: [],
    globals: [],
    heap: new Map(),
    heapTruncated: false,
    outputCount: 0,
    error: null,
    ...patch,
  }
}

/** A fake recording of `length` steps whose views come from `views(t)`. */
export function viewRecording(
  length: number,
  views: (t: number) => StateView,
  overrides: Partial<Recording> = {},
): Recording {
  return { ...fakeRecording({ length }), stateAt: views, ...overrides }
}

/** Renders `ui` inside a studio store holding `recording` with the pen at `time`. */
export function renderWithRecording(ui: ReactElement, recording: Recording | null, time = 0) {
  const store = createStudioStore(
    {
      engine: scriptedEngine(),
      storage: memoryStorage(),
      scheduler: new ManualScheduler(),
      examples: [],
    },
    { sharedSource: 'print(1)' },
  )
  store.setState({ recording, recordedSource: 'print(1)', time, status: { kind: 'ready' } })
  const result = render(<StudioProvider store={store}>{ui}</StudioProvider>)
  return { store, ...result }
}
