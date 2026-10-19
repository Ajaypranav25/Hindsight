import { useId, type ReactNode } from 'react'
import { ChevronIcon } from './icons'
import { PanelBoundary } from './PanelBoundary'
import './layout.css'

export interface PanelProps {
  readonly title: string
  /** Shown only when `onToggle` is given. */
  readonly collapsed?: boolean
  readonly onToggle?: () => void
  readonly className?: string
  readonly children: ReactNode
}

/**
 * An instrument module: a small uppercase label over a hairline rule and a body that scrolls
 * internally. With `onToggle` the label collapses and expands the body.
 */
export function Panel(props: PanelProps) {
  const id = useId()
  const collapsed = props.onToggle ? props.collapsed === true : false
  const classes = ['ch-panel', props.className].filter(Boolean).join(' ')
  return (
    <section className={classes} data-collapsed={collapsed} aria-labelledby={`${id}-title`}>
      <h2 className="ch-panel-head">
        {props.onToggle ? (
          <button
            type="button"
            id={`${id}-title`}
            className="ch-panel-toggle"
            aria-expanded={!collapsed}
            aria-controls={`${id}-body`}
            onClick={props.onToggle}
          >
            <ChevronIcon />
            <span className="ch-label">{props.title}</span>
          </button>
        ) : (
          <span id={`${id}-title`} className="ch-label">
            {props.title}
          </span>
        )}
      </h2>
      {!collapsed && (
        <div id={`${id}-body`} className="ch-panel-body">
          <PanelBoundary name={props.title}>{props.children}</PanelBoundary>
        </div>
      )}
    </section>
  )
}
