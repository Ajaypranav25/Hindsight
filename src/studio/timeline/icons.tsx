/** 16 px transport icons: strokes in currentColor, decorative (buttons carry the labels). */
import type { ReactNode } from 'react'

function Icon(props: { children: ReactNode }) {
  return (
    <svg
      className="tl-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

export function JumpStartIcon() {
  return (
    <Icon>
      <path d="M3.5 3v10" />
      <path d="M12.5 3.5 6.5 8l6 4.5z" />
    </Icon>
  )
}

export function JumpEndIcon() {
  return (
    <Icon>
      <path d="M12.5 3v10" />
      <path d="M3.5 3.5 9.5 8l-6 4.5z" />
    </Icon>
  )
}

export function ContinueBackIcon() {
  return (
    <Icon>
      <path d="M8 3.5 3.5 8 8 12.5" />
      <path d="M13 3.5 8.5 8l4.5 4.5" />
    </Icon>
  )
}

export function ContinueIcon() {
  return (
    <Icon>
      <path d="M3 3.5 7.5 8 3 12.5" />
      <path d="M8 3.5 12.5 8 8 12.5" />
    </Icon>
  )
}

export function StepOverBackIcon() {
  return (
    <Icon>
      <path d="M12.5 10.5a4.5 4.5 0 0 0-9 0" />
      <path d="M1.5 8.5l2 2 2-2" />
      <circle cx="8" cy="13" r="0.75" fill="currentColor" />
    </Icon>
  )
}

export function StepOverIcon() {
  return (
    <Icon>
      <path d="M3.5 10.5a4.5 4.5 0 0 1 9 0" />
      <path d="M10.5 8.5l2 2 2-2" />
      <circle cx="8" cy="13" r="0.75" fill="currentColor" />
    </Icon>
  )
}

export function StepBackIcon() {
  return (
    <Icon>
      <path d="M13 8H3" />
      <path d="M7 4 3 8l4 4" />
    </Icon>
  )
}

export function StepIntoIcon() {
  return (
    <Icon>
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </Icon>
  )
}

export function StepOutIcon() {
  return (
    <Icon>
      <path d="M2.5 13H8a4 4 0 0 0 4-4V3" />
      <path d="M9 6l3-3 3 3" />
    </Icon>
  )
}

export function PlayIcon() {
  return (
    <Icon>
      <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
    </Icon>
  )
}

export function PauseIcon() {
  return (
    <Icon>
      <path d="M5.5 3.5v9" />
      <path d="M10.5 3.5v9" />
    </Icon>
  )
}

export function InstructionBackIcon() {
  return (
    <Icon>
      <path d="M12.5 4v8" />
      <path d="M10 8H3.5" />
      <path d="M6 5.5 3.5 8 6 10.5" />
    </Icon>
  )
}

export function InstructionForwardIcon() {
  return (
    <Icon>
      <path d="M3.5 4v8" />
      <path d="M6 8h6.5" />
      <path d="M10 5.5 12.5 8 10 10.5" />
    </Icon>
  )
}
