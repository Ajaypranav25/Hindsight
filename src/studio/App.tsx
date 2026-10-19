import { useState, type ComponentType } from 'react'
import { Header } from './chrome/Header'
import { Hint } from './chrome/Hint'
import { Panel } from './chrome/Panel'
import { PanelBoundary } from './chrome/PanelBoundary'
import { PanelTabs } from './chrome/PanelTabs'
import { useGlobalShortcuts } from './chrome/useGlobalShortcuts'
import { useLayoutMode } from './chrome/useLayoutMode'
import { Editor } from './editor/Editor'
import { CallStack } from './panels/CallStack'
import { Console } from './panels/Console'
import { HeapGraph } from './panels/HeapGraph'
import { Variables } from './panels/Variables'
import { StripChart } from './timeline/StripChart'
import { TapeCounter } from './timeline/TapeCounter'
import { Transport } from './timeline/Transport'
import './chrome/layout.css'

type PanelId = 'stack' | 'variables' | 'heap' | 'console'

interface InstrumentPanel {
  readonly id: PanelId
  readonly title: string
  readonly Component: ComponentType
}

const CONSOLE: InstrumentPanel = { id: 'console', title: 'Console', Component: Console }

/** The desktop instrument column, top to bottom. Room is shared by weight in layout.css. */
const COLUMN_PANELS: readonly InstrumentPanel[] = [
  { id: 'stack', title: 'Call stack', Component: CallStack },
  { id: 'variables', title: 'Variables', Component: Variables },
  { id: 'heap', title: 'Heap', Component: HeapGraph },
]

/** Tablet and phone show every panel, the console included, as tabs. */
const TABBED_PANELS: readonly InstrumentPanel[] = [...COLUMN_PANELS, CONSOLE]

/**
 * The studio: header, editor (with the console beneath it on desktop) and instruments,
 * transport, and the strip chart along the bottom.
 */
export function App() {
  useGlobalShortcuts()
  const mode = useLayoutMode()
  const [collapsed, toggle] = useCollapsedPanels()
  const desktop = mode === 'desktop'
  return (
    <div
      className="app"
      data-layout={mode}
      data-console-collapsed={desktop && collapsed.has('console')}
    >
      <div className="app-header">
        <Header />
      </div>
      <section className="app-editor" aria-label="Program editor">
        <PanelBoundary name="The editor">
          <Editor />
        </PanelBoundary>
      </section>
      {desktop && (
        <div className="app-console">
          <Panel
            title={CONSOLE.title}
            className="app-panel app-panel-console"
            collapsed={collapsed.has('console')}
            onToggle={() => toggle('console')}
          >
            <Console />
          </Panel>
        </div>
      )}
      <div className="app-instruments">
        {desktop ? <StackedPanels collapsed={collapsed} toggle={toggle} /> : <TabbedPanels />}
      </div>
      <div className="app-hint">
        <Hint />
      </div>
      <div className="app-transport" role="group" aria-label="Transport">
        <PanelBoundary name="The transport">
          <Transport />
          <TapeCounter />
        </PanelBoundary>
      </div>
      <section className="app-chart" aria-label="Strip chart">
        <PanelBoundary name="The strip chart">
          <StripChart />
        </PanelBoundary>
      </section>
    </div>
  )
}

function useCollapsedPanels(): [ReadonlySet<PanelId>, (id: PanelId) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<PanelId>>(() => new Set())
  const toggle = (id: PanelId) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return [collapsed, toggle]
}

function StackedPanels(props: { collapsed: ReadonlySet<PanelId>; toggle: (id: PanelId) => void }) {
  return (
    <div className="app-stack">
      {COLUMN_PANELS.map(({ id, title, Component }) => (
        <Panel
          key={id}
          title={title}
          className={`app-panel app-panel-${id}`}
          collapsed={props.collapsed.has(id)}
          onToggle={() => props.toggle(id)}
        >
          <Component />
        </Panel>
      ))}
    </div>
  )
}

function TabbedPanels() {
  const panels = TABBED_PANELS.map(({ id, title, Component }) => ({
    id,
    title,
    content: <Component />,
  }))
  return <PanelTabs panels={panels} initial="variables" />
}
