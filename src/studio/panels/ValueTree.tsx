import { useMemo, useState, type ReactNode } from 'react'
import type { ObjectView, ValueView, WriteTarget } from '../../core/index'
import { formatCount, formatValue, reprString, truncate } from '../lib/format'
import { useStateView, useStudio, useStudioActions } from '../state/context'
import { formatRange, PAGE_SIZE } from './panel-logic'
import './panels.css'

const EXPANDABLE = new Set(['list', 'record', 'function', 'iterator'])
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ValueRowProps {
  /** Text in the name column: a variable name, `[3]` or a record key. */
  readonly name: string
  readonly value: ValueView
  /** Expression naming the value in notices, e.g. `xs[3]`. */
  readonly label: string
  /** Where the value lives; adds the "jump to origin" action. */
  readonly target?: WriteTarget
  /** Small kind badge (let, var, param, …). */
  readonly badge?: string
  /** Object ids on the path from the root, to cut cycles. */
  readonly path?: readonly number[]
  /** Extra actions after the origin action. */
  readonly actions?: ReactNode
  /** Set when the value just changed; a new number replays the flash. */
  readonly flash?: number | null
}

/** One name/value row; object values expand into child rows below it. */
export function ValueRow(props: ValueRowProps) {
  const { name, value, label, target, badge, path = [], actions, flash = null } = props
  const [expanded, setExpanded] = useState(false)
  const cycle = value.kind === 'ref' && path.includes(value.id)
  const expandable = isExpandable(value) && !cycle
  return (
    <li className="pn-row" data-changed={flash !== null ? 'true' : undefined}>
      {flash !== null && <span key={flash} className="pn-flash" aria-hidden="true" />}
      {name !== '' && <span className="pn-name">{name}</span>}
      {badge && <span className="pn-badge">{badge}</span>}
      <span className="pn-value-cell">
        {expandable ? (
          <button
            type="button"
            className="pn-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="pn-chevron" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="pn-value">{(value as { preview: string }).preview}</span>
          </button>
        ) : (
          <LeafValue value={value} cycle={cycle} />
        )}
      </span>
      {(target || actions) && (
        <span className="pn-actions">
          {target && <OriginButton target={target} label={label} />}
          {actions}
        </span>
      )}
      {expanded && value.kind === 'ref' && (
        <ObjectChildren id={value.id} label={label} path={[...path, value.id]} />
      )}
    </li>
  )
}

/** A standalone expandable tree for one value. */
export function ValueTree(props: { readonly value: ValueView; readonly label: string }) {
  return (
    <ul className="pn-tree">
      <ValueRow name="" value={props.value} label={props.label} />
    </ul>
  )
}

/** "⟲": moves the pen to the step that produced the value. */
export function OriginButton(props: { readonly target: WriteTarget; readonly label: string }) {
  const { jumpToOrigin } = useStudioActions()
  const text = `Jump to where ${props.label} was set`
  return (
    <button
      type="button"
      className="pn-act"
      aria-label={text}
      title={text}
      onClick={() => jumpToOrigin(props.target, props.label)}
    >
      ⟲
    </button>
  )
}

function isExpandable(value: ValueView): boolean {
  if (value.kind !== 'ref' || !EXPANDABLE.has(value.type)) return false
  return value.preview !== '[]' && value.preview !== '{}'
}

function LeafValue(props: { readonly value: ValueView; readonly cycle: boolean }) {
  const { value, cycle } = props
  if (value.kind !== 'ref') {
    const text = formatValue(value)
    return (
      <span
        className={`pn-value pn-value--${value.kind}`}
        title={text.length > 60 ? text : undefined}
      >
        {truncate(text, 400)}
      </span>
    )
  }
  if (cycle) {
    return (
      <span className="pn-value pn-value--muted" title="This object contains itself">
        ↺ {value.preview}
      </span>
    )
  }
  if (value.type === 'builtin' || value.type === 'range')
    return <ObjectLeaf id={value.id} preview={value.preview} />
  return <span className="pn-value">{value.preview}</span>
}

function ObjectLeaf(props: { readonly id: number; readonly preview: string }) {
  const object = useObjectView(props.id, PAGE_SIZE)
  let text = props.preview
  if (object?.type === 'builtin') text = `builtin ${object.name}`
  if (object?.type === 'range') text = formatRange(object)
  return <span className="pn-value pn-value--muted">{text}</span>
}

/** The object from the heap at the pen, or fetched with `objectAt` when missing or paged further. */
function useObjectView(id: number, limit: number): ObjectView | null {
  const recording = useStudio((s) => s.recording)
  const time = useStudio((s) => s.time)
  const view = useStateView()
  return useMemo(() => {
    const cached = view?.heap.get(id) ?? null
    if (cached && loadedCount(cached) >= Math.min(limit, totalCount(cached))) return cached
    if (!recording) return cached
    const at = Math.max(0, Math.min(time, recording.length))
    return recording.objectAt(at, id, { offset: 0, limit }) ?? cached
  }, [recording, time, view, id, limit])
}

function loadedCount(object: ObjectView): number {
  if (object.type === 'list') return object.offset + object.items.length
  if (object.type === 'record') return object.offset + object.entries.length
  return 0
}

function totalCount(object: ObjectView): number {
  return object.type === 'list' || object.type === 'record' ? object.length : 0
}

function fieldLabel(label: string, key: string): string {
  return IDENTIFIER.test(key) ? `${label}.${key}` : `${label}[${reprString(key)}]`
}

function ObjectChildren(props: {
  readonly id: number
  readonly label: string
  readonly path: readonly number[]
}) {
  const { id, label, path } = props
  const [limit, setLimit] = useState(PAGE_SIZE)
  const object = useObjectView(id, limit)
  if (!object) return <p className="pn-children pn-note">Not reachable at this step</p>
  const total = totalCount(object)
  const shown = loadedCount(object)
  return (
    <div className="pn-children">
      <ul className="pn-tree">{childRows(object, label, path)}</ul>
      {shown < total && (
        <button type="button" className="pn-more" onClick={() => setLimit(limit + PAGE_SIZE)}>
          Show {formatCount(Math.min(PAGE_SIZE, total - shown))} more (of {formatCount(total)})
        </button>
      )}
    </div>
  )
}

function childRows(object: ObjectView, label: string, path: readonly number[]): ReactNode {
  switch (object.type) {
    case 'list':
      return object.items.map((item, i) => {
        const index = object.offset + i
        const target: WriteTarget = { kind: 'element', objectId: object.id, index }
        return (
          <ValueRow
            key={index}
            name={`[${index}]`}
            value={item}
            label={`${label}[${index}]`}
            target={target}
            path={path}
          />
        )
      })
    case 'record':
      return object.entries.map(({ key, value }) => {
        const target: WriteTarget = { kind: 'field', objectId: object.id, key }
        return (
          <ValueRow
            key={key}
            name={key}
            value={value}
            label={fieldLabel(label, key)}
            target={target}
            path={path}
          />
        )
      })
    case 'function':
      return <FunctionRows object={object} label={label} path={path} />
    case 'iterator':
      return (
        <>
          <ValueRow name="source" value={object.source} label={`${label} source`} path={path} />
          <ValueRow
            name="position"
            value={{ kind: 'number', value: object.position }}
            label={`${label} position`}
          />
        </>
      )
    default:
      return null
  }
}

function FunctionRows(props: {
  readonly object: Extract<ObjectView, { type: 'function' }>
  readonly label: string
  readonly path: readonly number[]
}) {
  const { object, path } = props
  const name = object.name ?? 'lambda'
  return (
    <>
      <li className="pn-row pn-row--note">
        <span className="pn-note">
          fn <span className="pn-value">{name}</span>
          {object.library ? ' · library' : ''}
          {object.captures.length === 0 ? ' · captures nothing' : ''}
        </span>
      </li>
      {object.captures.map((capture) => (
        <ValueRow
          key={capture.name}
          name={capture.name}
          badge="cap"
          value={capture.value}
          label={capture.name}
          target={capture.target}
          path={path}
        />
      ))}
    </>
  )
}
