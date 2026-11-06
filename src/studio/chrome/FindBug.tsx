import { useStudio, useStudioActions } from '../state/context'

/** A beetle, drawn like the other chrome icons (16 px, currentColor strokes). */
function BugIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="ch-icon"
    >
      <ellipse cx="8" cy="9.5" rx="3.25" ry="4.25" />
      <path d="M6.5 4.6a1.5 1.5 0 013 0M8 6.5v7M4.8 8H2.5M4.8 11H2.8M11.2 8h2.3M11.2 11h2M5.6 5.4L4 4M10.4 5.4L12 4" />
    </svg>
  )
}

/**
 * Opens the bug finder (ARCHITECTURE §7.6): starts an interview about the whole program and
 * reveals its panel, or, after a run that failed, explains why to start with the error.
 */
export function FindBug() {
  const { openBugFinder } = useStudioActions()
  const ready = useStudio((s) => s.recording !== null)
  return (
    <button
      type="button"
      className="ch-button"
      aria-label="Find the bug"
      title="Find the bug: answer questions about the calls your program made"
      disabled={!ready}
      onClick={openBugFinder}
    >
      <BugIcon />
      <span className="ch-collapsible-label" aria-hidden="true">
        Find the bug
      </span>
    </button>
  )
}
