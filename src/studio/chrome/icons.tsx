/** Small inline SVG icons for the chrome; all draw with currentColor. */
const BASE = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

export function ChevronIcon() {
  return (
    <svg {...BASE} className="ch-icon ch-chevron">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

export function RunIcon() {
  return (
    <svg {...BASE} className="ch-icon">
      <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
    </svg>
  )
}

export function ShareIcon() {
  return (
    <svg {...BASE} className="ch-icon">
      <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.6 3.6L10.6 8M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.6-3.6L5.4 8" />
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg {...BASE} className="ch-icon">
      <path d="M3 4h10M3 8h10M3 12h10" />
      <circle cx="6" cy="4" r="1.4" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.4" fill="currentColor" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
    </svg>
  )
}

export function HelpIcon() {
  return (
    <svg {...BASE} className="ch-icon">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8" />
      <circle cx="8" cy="11.6" r=".6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function CloseIcon() {
  return (
    <svg {...BASE} className="ch-icon">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
