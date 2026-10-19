import { useState } from 'react'
import type { Recording, StateView, ValueView, WriteTarget } from '../../core/index'
import { useSelectedFrame, useStateView, useStudio, useStudioActions } from '../state/context'
import { History } from './History'
import { changedTargets, sameTarget, targetKey } from './panel-logic'
import { ValueRow } from './ValueTree'
import './panels.css'

interface Row {
  readonly name: string
  readonly badge: string
  readonly value: ValueView
  readonly target: WriteTarget
}

interface Group {
  readonly id: string
  readonly title: string
  readonly rows: readonly Row[]
}

interface Changes {
  readonly recording: Recording | null
  readonly view: StateView | null
  readonly changed: ReadonlySet<string>
  /** Bumped on every pen move so a repeated change replays the flash. */
  readonly generation: number
}

const NO_CHANGES: ReadonlySet<string> = new Set()

/** Locals, captured variables and globals at the pen, for the selected frame. */
export function Variables() {
  const recording = useStudio((s) => s.recording)
  const view = useStateView()
  const frame = useSelectedFrame()
  const watching = useStudio((s) => s.watch !== null)
  const changes = useChanges(recording, view)
  if (!view) return <p className="pn-empty">Run the program to see its variables</p>
  const groups: Group[] = [
    {
      id: 'locals',
      title: frame ? `Locals · ${frame.name}` : 'Locals',
      rows: (frame?.locals ?? []).map((l) => ({
        name: l.name,
        badge: l.kind,
        value: l.value,
        target: l.target,
      })),
    },
    {
      id: 'captured',
      title: 'Captured',
      rows: (frame?.captures ?? []).map((c) => ({
        name: c.name,
        badge: 'cap',
        value: c.value,
        target: c.target,
      })),
    },
    {
      id: 'globals',
      title: 'Globals',
      rows: view.globals.map((g) => ({
        name: g.name,
        badge: g.kind,
        value: g.value,
        target: g.target,
      })),
    },
  ].filter((group) => group.rows.length > 0)
  return (
    <div className="pn-vars">
      {watching && <History />}
      {groups.length === 0 && <p className="pn-empty">No variables yet: step forward</p>}
      {groups.map((group) => (
        <section key={group.id} className="pn-group" aria-labelledby={`pn-group-${group.id}`}>
          <h3 className="pn-label" id={`pn-group-${group.id}`}>
            {group.title}
          </h3>
          <ul className="pn-tree">
            {group.rows.map((row) => {
              const key = targetKey(row.target)
              return (
                <ValueRow
                  key={key}
                  name={row.name}
                  badge={row.badge}
                  value={row.value}
                  label={row.name}
                  target={row.target}
                  flash={changes.changed.has(key) ? changes.generation : null}
                  actions={<HistoryButton target={row.target} name={row.name} />}
                />
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Toggles the binding's history (strip-chart marks and the history list). */
function HistoryButton(props: { readonly target: WriteTarget; readonly name: string }) {
  const watched = useStudio((s) => sameTarget(s.watch?.target, props.target))
  const { setWatch } = useStudioActions()
  const text = watched ? `Hide the history of ${props.name}` : `Show the history of ${props.name}`
  return (
    <button
      type="button"
      className="pn-act pn-act--word"
      aria-pressed={watched}
      aria-label={text}
      title={text}
      onClick={() => (watched ? setWatch(null) : setWatch(props.target, props.name))}
    >
      history
    </button>
  )
}

/**
 * The bindings that changed since the previous pen position of the same recording, using the
 * "adjust state while rendering" pattern so the comparison happens once per pen move.
 */
function useChanges(recording: Recording | null, view: StateView | null): Changes {
  const [changes, setChanges] = useState<Changes>({
    recording,
    view,
    changed: NO_CHANGES,
    generation: 0,
  })
  if (changes.recording === recording && changes.view === view) return changes
  const sameRun = changes.recording === recording && view !== null
  const next: Changes = {
    recording,
    view,
    changed: sameRun ? changedTargets(changes.view, view) : NO_CHANGES,
    generation: changes.generation + 1,
  }
  setChanges(next)
  return next
}
