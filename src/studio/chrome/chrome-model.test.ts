import { describe, expect, test } from 'vitest'
import { compile, record } from '../../core/index'
import type { Diagnostic, Recording } from '../../core/index'
import { DEFAULT_SETTINGS } from '../state/defaults'
import { fakeRecording } from '../state/testing'
import type { StudioState } from '../state/types'
import { staleBadge, statusLine } from './status-model'
import { applyTheme } from './theme'

function state(patch: Partial<StudioState> = {}): StudioState {
  return {
    source: 'print(1)\n',
    exampleId: null,
    compile: null,
    recording: null,
    recordedSource: null,
    status: { kind: 'idle' },
    time: 0,
    selectedFrameUid: null,
    breakpoints: new Set(),
    watch: null,
    playing: false,
    settings: DEFAULT_SETTINGS,
    hintDismissed: false,
    notice: null,
    ...patch,
  }
}

function recorded(source: string): StudioState {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  const recording: Recording = record(result.program)
  return state({ source, recordedSource: source, recording, status: { kind: 'ready' } })
}

describe('statusLine', () => {
  test('idle before the first run', () => {
    expect(statusLine(state()).head).toBe('Ready')
  })

  test('recording progress with grouped digits', () => {
    const line = statusLine(state({ status: { kind: 'recording', progress: 340_000 } }))
    expect([line.tone, line.head, line.detail]).toEqual(['busy', 'Recording', '340,000 steps'])
  })

  test('a finished run counts steps and printed lines', () => {
    const line = statusLine(recorded('print(1)\nprint(2)\n'))
    expect(line.head).toBe('Finished')
    expect(line.detail).toMatch(/^[\d,]+ steps · 2 lines printed$/)
    expect(statusLine(recorded('let x = 1\n')).detail).toMatch(/nothing printed$/)
  })

  test('a runtime error names its line and jumps to the end', () => {
    const line = statusLine(recorded('let xs = [1, 2]\n\nprint(xs[5])\n'))
    expect(line.tone).toBe('error')
    expect(line.head).toBe('Runtime error on line 3')
    expect(line.detail.length).toBeGreaterThan(0)
    expect(line.action).toBe('jump-to-end')
  })

  test('the step limit offers to record more', () => {
    const recording = fakeRecording({
      length: 500_000,
      outcome: { kind: 'step-limit', maxSteps: 500_000 },
    })
    const line = statusLine(
      state({ recording, status: { kind: 'ready' }, settings: { ...DEFAULT_SETTINGS } }),
    )
    expect(line.head).toBe('Stopped at the step limit')
    expect(line.detail).toBe('500,000 steps')
    expect(line.button).toEqual({ label: 'Record 2M more', action: 'extend' })
  })

  test('compile errors count errors and show the first line', () => {
    const source = 'let a = 1\n\nprint(x)\n'
    const diagnostics: Diagnostic[] = [
      {
        code: 'E020',
        severity: 'error',
        message: "undefined variable 'x'",
        span: { start: 17, end: 18 },
      },
      {
        code: 'E020',
        severity: 'error',
        message: "undefined variable 'y'",
        span: { start: 19, end: 20 },
      },
    ]
    const line = statusLine(state({ source, status: { kind: 'compile-error', diagnostics } }))
    expect(line.head).toBe('2 errors')
    expect(line.detail).toBe("line 3: undefined variable 'x'")
  })
})

describe('staleBadge', () => {
  const base = recorded('print(1)\n')
  const edited = { ...base, source: 'print(2)\n' }

  test('no badge while the recording matches the editor', () => {
    expect(staleBadge(base, 'Ctrl+Enter')).toBeNull()
  })

  test('no badge when an auto-run is pending', () => {
    expect(staleBadge({ ...edited, compile: compile(edited.source) }, 'Ctrl+Enter')).toBeNull()
  })

  test('asks for a re-run when auto-run is off', () => {
    const off = { ...edited, settings: { ...DEFAULT_SETTINGS, autoRun: false } }
    expect(staleBadge(off, 'Ctrl+Enter')).toBe('Code changed · Ctrl+Enter to re-run')
  })

  test('explains the old run is shown while the code does not compile', () => {
    const broken = { ...edited, status: { kind: 'compile-error' as const, diagnostics: [] } }
    expect(staleBadge(broken, 'Ctrl+Enter')).toBe('Showing the last run that compiled')
  })
})

describe('applyTheme', () => {
  test('sets or removes data-theme', () => {
    const attrs = new Map<string, string>()
    const root = {
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      removeAttribute: (name: string) => void attrs.delete(name),
    }
    applyTheme('dark', root)
    expect(attrs.get('data-theme')).toBe('dark')
    applyTheme('light', root)
    expect(attrs.get('data-theme')).toBe('light')
    applyTheme('system', root)
    expect(attrs.has('data-theme')).toBe(false)
  })
})
