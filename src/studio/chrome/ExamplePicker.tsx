import { useEffect, useRef, type KeyboardEvent } from 'react'
import { EXAMPLES } from '../examples'
import { useStudio, useStudioActions } from '../state/context'
import type { Example } from '../state/types'
import { ChevronIcon } from './icons'
import { usePopover } from './usePopover'

/** A menu of gallery programs; choosing one loads and records it. */
export function ExamplePicker(props: { examples?: readonly Example[] }) {
  const examples = props.examples ?? EXAMPLES
  const exampleId = useStudio((s) => s.exampleId)
  const { loadExample } = useStudioActions()
  const { open, toggle, close, rootRef, triggerRef } = usePopover()
  const listRef = useRef<HTMLUListElement>(null)
  const current = examples.find((example) => example.id === exampleId) ?? null

  useEffect(() => {
    if (!open) return
    const items = menuItems(listRef.current)
    const selected = items.find((item) => item.getAttribute('aria-checked') === 'true')
    ;(selected ?? items[0])?.focus()
  }, [open])

  const choose = (id: string) => {
    close(true)
    loadExample(id)
  }

  return (
    <div className="ch-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ch-button ch-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="ch-label ch-picker-label">Examples</span>
        <span className="ch-picker-current">{current ? current.title : 'Your program'}</span>
        <ChevronIcon />
      </button>
      {open && (
        <ul
          ref={listRef}
          className="ch-pop ch-menu"
          role="menu"
          aria-label="Example programs"
          onKeyDown={(event) =>
            event.key === 'Tab' ? close(false) : moveFocus(event, listRef.current)
          }
        >
          {examples.map((example) => (
            <li key={example.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={example.id === exampleId}
                tabIndex={-1}
                className="ch-menu-item"
                onClick={() => choose(example.id)}
              >
                <span className="ch-menu-title">{example.title}</span>
                {example.summary && <span className="ch-menu-summary">{example.summary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function menuItems(list: HTMLElement | null): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>('[role^="menuitem"]')) : []
}

/** Arrow keys, Home and End move between menu items; Tab closes by leaving the menu. */
function moveFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null): void {
  const items = menuItems(list)
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLElement)
  const last = items.length - 1
  const targets: Readonly<Record<string, number>> = {
    ArrowDown: index < 0 || index === last ? 0 : index + 1,
    ArrowUp: index <= 0 ? last : index - 1,
    Home: 0,
    End: last,
  }
  const target = targets[event.key]
  if (target === undefined) return
  event.preventDefault()
  items[target]?.focus()
}
