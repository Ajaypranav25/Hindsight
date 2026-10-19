/** What the header's status line says, derived from studio state (pure, unit-tested). */
import { LineIndex } from '../../core/index'
import type { Diagnostic } from '../../core/index'
import { formatCount, formatSteps, truncate } from '../lib/format'
import type { StudioState } from '../state/types'

/** The parts of studio state the status line reads. */
export type StatusInputs = Pick<
  StudioState,
  'status' | 'recording' | 'source' | 'recordedSource' | 'settings' | 'compile'
>

export type StatusTone = 'idle' | 'busy' | 'ok' | 'error' | 'warn'

export type StatusAction = 'jump-to-end' | 'extend'

export interface StatusLine {
  readonly tone: StatusTone
  /** Short leading phrase ("Finished", "Runtime error on line 7"). */
  readonly head: string
  /** The rest of the sentence, shown after a separator. */
  readonly detail: string
  /** Clicking the status does this ("jump-to-end" for runtime errors). */
  readonly action: StatusAction | null
  /** A separate button ("Record 2M more"). */
  readonly button: { readonly label: string; readonly action: StatusAction } | null
}

const MESSAGE_LIMIT = 140

function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`
}

function lineOf(source: string | null, offset: number): number {
  return new LineIndex(source ?? '').lineOf(offset)
}

function compileErrorLine(state: StatusInputs, diagnostics: readonly Diagnostic[]): StatusLine {
  const errors = diagnostics.filter((d) => d.severity === 'error')
  const shown = errors.length > 0 ? errors : diagnostics
  const first = shown[0]
  return {
    tone: 'error',
    head: plural(shown.length, 'error', 'errors'),
    detail: first
      ? `line ${lineOf(state.source, first.span.start)}: ${truncate(first.message, MESSAGE_LIMIT)}`
      : '',
    action: null,
    button: null,
  }
}

function recordingLine(state: StatusInputs): StatusLine {
  const recording = state.recording!
  const outcome = recording.outcome
  const steps = plural(recording.length, 'step', 'steps')
  const more: StatusLine['button'] = {
    label: `Record ${formatSteps(state.settings.maxSteps)} more`,
    action: 'extend',
  }
  switch (outcome.kind) {
    case 'finished': {
      const lines = recording.outputs.length
      const printed = lines === 0 ? 'nothing printed' : `${plural(lines, 'line', 'lines')} printed`
      return {
        tone: 'ok',
        head: 'Finished',
        detail: `${steps} · ${printed}`,
        action: null,
        button: null,
      }
    }
    case 'error':
      return {
        tone: 'error',
        head: `Runtime error on line ${lineOf(state.recordedSource, outcome.error.span.start)}`,
        detail: truncate(outcome.error.message, MESSAGE_LIMIT),
        action: 'jump-to-end',
        button: null,
      }
    case 'step-limit':
      return {
        tone: 'warn',
        head: 'Stopped at the step limit',
        detail: steps,
        action: null,
        button: more,
      }
    case 'aborted':
      return { tone: 'warn', head: 'Recording stopped', detail: steps, action: null, button: more }
  }
}

/** The status line for the current state. */
export function statusLine(state: StatusInputs): StatusLine {
  const status = state.status
  if (status.kind === 'recording')
    return {
      tone: 'busy',
      head: 'Recording',
      detail: plural(status.progress, 'step', 'steps'),
      action: null,
      button: null,
    }
  if (status.kind === 'compile-error') return compileErrorLine(state, status.diagnostics)
  if (state.recording) return recordingLine(state)
  return { tone: 'idle', head: 'Ready', detail: 'Press Run to record', action: null, button: null }
}

/**
 * The stale badge: shown when the recording no longer matches the editor, unless an auto-run is
 * about to replace it. Null when the recording is current.
 */
export function staleBadge(state: StatusInputs, runLabel: string): string | null {
  const stale = state.recording !== null && state.recordedSource !== state.source
  if (!stale || state.status.kind === 'recording') return null
  if (state.status.kind === 'compile-error') return 'Showing the last run that compiled'
  const autoRunPending = state.settings.autoRun && state.compile?.ok === true
  return autoRunPending ? null : `Code changed · ${runLabel} to re-run`
}
