import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PanelBoundary } from './PanelBoundary'
import './layout.css'

export interface TabbedPanel {
  readonly id: string
  readonly title: string
  readonly content: ReactNode
}

/** The instrument panels as a tab strip (tablet and phone); only the chosen panel renders. */
export function PanelTabs(props: { panels: readonly TabbedPanel[]; initial?: string }) {
  const baseId = useId()
  const [selected, setSelected] = useState(props.initial ?? props.panels[0]?.id ?? '')
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const current = props.panels.find((panel) => panel.id === selected) ?? props.panels[0]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = props.panels.findIndex((panel) => panel.id === current?.id)
    const last = props.panels.length - 1
    const targets: Readonly<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index <= 0 ? last : index - 1,
      Home: 0,
      End: last,
    }
    const target = targets[event.key]
    const panel = target === undefined ? undefined : props.panels[target]
    if (!panel) return
    event.preventDefault()
    setSelected(panel.id)
    tabRefs.current.get(panel.id)?.focus()
  }

  return (
    <div className="ch-tabs">
      <div className="ch-tablist" role="tablist" aria-label="Instruments" onKeyDown={onKeyDown}>
        {props.panels.map((panel) => {
          const active = panel.id === current?.id
          return (
            <button
              key={panel.id}
              ref={(node) => {
                if (node) tabRefs.current.set(panel.id, node)
                else tabRefs.current.delete(panel.id)
              }}
              type="button"
              role="tab"
              id={`${baseId}-${panel.id}-tab`}
              aria-selected={active}
              aria-controls={`${baseId}-${panel.id}-panel`}
              tabIndex={active ? 0 : -1}
              className="ch-tab"
              onClick={() => setSelected(panel.id)}
            >
              {panel.title}
            </button>
          )
        })}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`${baseId}-${current.id}-panel`}
          aria-labelledby={`${baseId}-${current.id}-tab`}
          className="ch-tabpanel"
        >
          <PanelBoundary key={current.id} name={current.title}>
            {current.content}
          </PanelBoundary>
        </div>
      )}
    </div>
  )
}
