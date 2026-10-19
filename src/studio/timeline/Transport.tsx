/** Transport controls: travel through the recording like a tape deck, in both directions. */
import { useId, type ReactNode } from 'react'
import { useStudio, useStudioActions } from '../state/context'
import type { StudioActions } from '../state/types'
import {
  ContinueBackIcon,
  ContinueIcon,
  InstructionBackIcon,
  InstructionForwardIcon,
  JumpEndIcon,
  JumpStartIcon,
  PauseIcon,
  PlayIcon,
  StepBackIcon,
  StepIntoIcon,
  StepOutIcon,
  StepOverBackIcon,
  StepOverIcon,
} from './icons'
import './timeline.css'

/** Statements per second offered by the speed control. */
export const PLAYBACK_SPEEDS = [1, 2, 4, 8, 15, 30, 60] as const

interface ButtonSpec {
  readonly id: string
  readonly label: string
  readonly shortcut: string
  readonly icon: ReactNode
  readonly run: (actions: StudioActions) => void
}

const BACKWARD: readonly ButtonSpec[] = [
  {
    id: 'start',
    label: 'Jump to start',
    shortcut: 'Home',
    icon: <JumpStartIcon />,
    run: (a) => a.jumpToStart(),
  },
  {
    id: 'continue-back',
    label: 'Continue backward to the previous breakpoint',
    shortcut: 'Shift+F8',
    icon: <ContinueBackIcon />,
    run: (a) => a.continueNav('backward'),
  },
  {
    id: 'over-back',
    label: 'Step back over',
    shortcut: 'Shift+F10',
    icon: <StepOverBackIcon />,
    run: (a) => a.stepNav('over', 'backward'),
  },
  {
    id: 'into-back',
    label: 'Step back into',
    shortcut: 'Shift+F11',
    icon: <StepBackIcon />,
    run: (a) => a.stepNav('into', 'backward'),
  },
]

const FORWARD: readonly ButtonSpec[] = [
  {
    id: 'into',
    label: 'Step into',
    shortcut: 'F11',
    icon: <StepIntoIcon />,
    run: (a) => a.stepNav('into', 'forward'),
  },
  {
    id: 'over',
    label: 'Step over',
    shortcut: 'F10',
    icon: <StepOverIcon />,
    run: (a) => a.stepNav('over', 'forward'),
  },
  {
    id: 'out',
    label: 'Step out',
    shortcut: 'F7, Shift+F7 backward',
    icon: <StepOutIcon />,
    run: (a) => a.stepNav('out', 'forward'),
  },
  {
    id: 'continue',
    label: 'Continue to the next breakpoint',
    shortcut: 'F8',
    icon: <ContinueIcon />,
    run: (a) => a.continueNav('forward'),
  },
  {
    id: 'end',
    label: 'Jump to end',
    shortcut: 'End',
    icon: <JumpEndIcon />,
    run: (a) => a.jumpToEnd(),
  },
]

function TransportButton(props: { spec: ButtonSpec; disabled: boolean; actions: StudioActions }) {
  const { spec, disabled, actions } = props
  return (
    <button
      type="button"
      className="tl-button"
      aria-label={spec.label}
      title={`${spec.label} (${spec.shortcut})`}
      disabled={disabled}
      onClick={() => spec.run(actions)}
    >
      {spec.icon}
    </button>
  )
}

export function Transport() {
  const actions = useStudioActions()
  const hasRecording = useStudio((s) => s.recording !== null)
  const playing = useStudio((s) => s.playing)
  const instructionLevel = useStudio((s) => s.settings.instructionLevel)
  const disabled = !hasRecording
  const button = (spec: ButtonSpec) => (
    <TransportButton key={spec.id} spec={spec} disabled={disabled} actions={actions} />
  )
  return (
    <div className="tl-transport" role="toolbar" aria-label="Time travel">
      <div className="tl-transport__group">
        {BACKWARD.map(button)}
        {instructionLevel && (
          <InstructionButton direction="backward" disabled={disabled} actions={actions} />
        )}
        <button
          type="button"
          className="tl-button tl-button--play"
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          title={`${playing ? 'Pause' : 'Play statement by statement'} (Space)`}
          disabled={disabled}
          onClick={() => actions.togglePlay()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        {instructionLevel && (
          <InstructionButton direction="forward" disabled={disabled} actions={actions} />
        )}
        {FORWARD.map(button)}
      </div>
      <SpeedControl disabled={disabled} />
      {instructionLevel && <OpName />}
    </div>
  )
}

function InstructionButton(props: {
  direction: 'forward' | 'backward'
  disabled: boolean
  actions: StudioActions
}) {
  const forward = props.direction === 'forward'
  const label = forward ? 'Forward one instruction' : 'Back one instruction'
  return (
    <button
      type="button"
      className="tl-button tl-button--instruction"
      aria-label={label}
      title={label}
      disabled={props.disabled}
      onClick={() => props.actions.stepInstruction(props.direction)}
    >
      {forward ? <InstructionForwardIcon /> : <InstructionBackIcon />}
    </button>
  )
}

function SpeedControl(props: { disabled: boolean }) {
  const id = useId()
  const speed = useStudio((s) => s.settings.playbackSpeed)
  const playing = useStudio((s) => s.playing)
  const actions = useStudioActions()
  const options: readonly number[] = PLAYBACK_SPEEDS.includes(speed as never)
    ? PLAYBACK_SPEEDS
    : [...PLAYBACK_SPEEDS, speed].sort((a, b) => a - b)
  const change = (value: number) => {
    actions.updateSettings({ playbackSpeed: value })
    if (playing) {
      actions.stopPlay()
      actions.togglePlay()
    }
  }
  return (
    <div className="tl-speed">
      <label className="tl-speed__label" htmlFor={id}>
        Speed
      </label>
      <select
        id={id}
        className="tl-speed__select"
        value={speed}
        disabled={props.disabled}
        title="Playback speed in statements per second"
        onChange={(event) => change(Number(event.target.value))}
      >
        {options.map((value) => (
          <option key={value} value={value}>
            {value}/s
          </option>
        ))}
      </select>
    </div>
  )
}

function OpName() {
  const opName = useStudio((s) => {
    if (!s.recording || s.time > s.recording.length) return null
    return s.recording.locationAt(s.time)?.opName ?? null
  })
  return (
    <span className="tl-opname" aria-label="Current instruction">
      <span className="tl-opname__label">Op</span>
      <span className="tl-opname__value">{opName ?? '—'}</span>
    </span>
  )
}
