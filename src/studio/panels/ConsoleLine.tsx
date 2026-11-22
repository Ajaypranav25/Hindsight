/**
 * One line of program output in the console (ARCHITECTURE §11.3): a button that moves the pen to
 * the moment it was printed, the line's tools ("What led to this?", "Make this print…") and its
 * context menu, opened by a right-click, the ContextMenu key or Shift+F10.
 */
import { type KeyboardEvent, type MouseEvent, useRef } from 'react'
import type { OutputEvent } from '../../core/index'
import { anchorBelow, ContextMenu, type MenuAction, type MenuAnchor } from '../chrome/ContextMenu'
import { clipText, formatCount } from '../lib/format'
import { WishForm } from './MakeItSo'

/** What a console line can ask for. */
export interface LineActions {
  readonly seek: (time: number) => void
  /** Opens or closes the "Make this print…" form under the line. */
  readonly setWishing: (open: boolean) => void
  readonly wish: (text: string) => void
  /** "What led to this?": traces the causes of the step that printed the line. */
  readonly slice: () => void
  /** Opens the line's context menu at `anchor`, or closes it (null). */
  readonly setMenu: (anchor: MenuAnchor | null) => void
  /** Copies the line's text; `node` holds it, to select when the clipboard refuses. */
  readonly copy: (node: Node | null) => void
}

export function OutputLine(props: {
  readonly event: OutputEvent
  /** The line's index in the run's output. */
  readonly index: number
  readonly time: number
  readonly lastPrinted: boolean
  /** Not printed by the real run (in what-if mode). */
  readonly changed: boolean
  /** The "make this print" form is open under this line. */
  readonly wishing: boolean
  /** Where the line's context menu is open, or null. */
  readonly menu: MenuAnchor | null
  readonly actions: LineActions
}) {
  const { event, index, time, lastPrinted, changed, wishing, menu, actions } = props
  const lineButton = useRef<HTMLButtonElement>(null)
  const wishButton = useRef<HTMLButtonElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const closeForm = () => {
    actions.setWishing(false)
    wishButton.current?.focus()
  }
  const closeMenu = (restoreFocus: boolean) => {
    actions.setMenu(null)
    if (restoreFocus) lineButton.current?.focus()
  }
  const onKeyDown = (key: KeyboardEvent<HTMLDivElement>) => {
    if (key.key !== 'ContextMenu' && !(key.key === 'F10' && key.shiftKey)) return
    key.preventDefault()
    key.stopPropagation()
    if (lineButton.current !== null) actions.setMenu(anchorBelow(lineButton.current))
  }
  const onContextMenu = (click: MouseEvent<HTMLDivElement>) => {
    click.preventDefault()
    const fromKeyboard = click.clientX === 0 && click.clientY === 0
    if (fromKeyboard && lineButton.current !== null) {
      actions.setMenu(anchorBelow(lineButton.current))
    } else {
      actions.setMenu({ x: click.clientX, y: click.clientY })
    }
  }
  const atPen = event.time === time
  const future = event.time >= time
  const className = `pn-line${future ? ' pn-line--future' : ''}${atPen ? ' pn-line--now' : ''}`
  const menuActions: MenuAction[] = [
    {
      label: 'Make this print…',
      detail: 'Find an earlier value that changes it',
      onSelect: () => actions.setWishing(true),
      restoreFocus: false,
    },
    {
      label: 'What led to this?',
      detail: 'Mark the lines it was computed from',
      onSelect: actions.slice,
    },
    {
      label: 'Go to this moment',
      detail: `Step ${formatCount(event.time)}`,
      onSelect: () => actions.seek(event.time),
    },
    { label: 'Copy line', onSelect: () => actions.copy(textRef.current) },
  ]
  return (
    <li className={className} data-last-printed={lastPrinted ? 'true' : undefined}>
      <div
        className="pn-line-row"
        data-context-menu=""
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        <button
          ref={lineButton}
          type="button"
          className="pn-line-btn"
          aria-current={atPen ? 'step' : undefined}
          title={`Printed at step ${formatCount(event.time)}${future ? ' (after the pen)' : ''} · right-click for more`}
          onClick={() => actions.seek(event.time)}
        >
          <span className="pn-stamp">{formatCount(event.time)}</span>
          <span className="pn-out" ref={textRef}>
            {clipText(event.text)}
          </span>
          {changed && (
            <span
              className="pn-badge pn-badge--whatif"
              title="The real run did not print this line"
            >
              changed
            </span>
          )}
        </button>
        <span className="pn-line-tools">
          <button
            type="button"
            className="pn-line-tool"
            title={`Mark the lines that led to output line ${formatCount(index + 1)}`}
            onClick={actions.slice}
          >
            What led to this?
          </button>
          <button
            ref={wishButton}
            type="button"
            className="pn-line-tool"
            aria-expanded={wishing}
            title="Find an earlier value that makes this line print something else"
            onClick={() => actions.setWishing(!wishing)}
          >
            Make this print…
          </button>
        </span>
      </div>
      {wishing && <WishForm current={event.text} onWish={actions.wish} onCancel={closeForm} />}
      {menu !== null && (
        <ContextMenu
          label={`Output line ${formatCount(index + 1)}`}
          anchor={menu}
          actions={menuActions}
          onClose={closeMenu}
        />
      )}
    </li>
  )
}
