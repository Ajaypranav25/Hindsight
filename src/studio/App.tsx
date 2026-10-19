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

/** The instrument column, top to bottom. Room is shared by weight in layout.css. */
const PANELS: readonly InstrumentPanel[] = [
  { id: 'stack', title: 'Call stack', Component: CallStack },
  { id: 'variables', title: 'Variables', Component: Variables },
  { id: 'heap', title: 'Heap', Component: HeapGraph },
  { id: 'console', title: 'Console', Component: Console },
]

/** The studio: header, editor and instruments, transport, and the strip chart along the bottom. */
export function App() {
  useGlobalShortcuts()
  const mode = useLayoutMode()
  return (
    <div className="app" data-layout={mode}>
      <div className="app-header">
        <Header />
      </div>
      <section className="app-editor" aria-label="Program editor">
        <PanelBoundary name="The editor">
          <Editor />
        </PanelBoundary>
      </section>
      <div className="app-instruments">
        {mode === 'desktop' ? <StackedPanels /> : <TabbedPanels />}
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

function StackedPanels() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<PanelId>>(() => new Set())
  const toggle = (id: PanelId) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="app-stack">
      {PANELS.map(({ id, title, Component }) => (
        <Panel
          key={id}
          title={title}
          className={`app-panel app-panel-${id}`}
          collapsed={collapsed.has(id)}
          onToggle={() => toggle(id)}
        >
          <Component />
        </Panel>
      ))}
    </div>
  )
}

function TabbedPanels() {
  const panels = PANELS.map(({ id, title, Component }) => ({
    id,
    title,
    content: <Component />,
  }))
  return <PanelTabs panels={panels} initial="variables" />
}
