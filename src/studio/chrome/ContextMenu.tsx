/**
 * A small context menu (ARCHITECTURE §11.3): opened by a right-click, the ContextMenu key or
 * Shift+F10 at a point on the page. Accessible as a WAI-ARIA menu: focus moves to the first item,
 * the arrow keys, Home and End move between items, Enter or Space chooses one, and Escape or Tab
 * closes it and gives focus back to where it was opened from. A click elsewhere, a scroll or a
 * resize closes it too. It is drawn in a portal so a scrolling panel cannot clip it.
 */
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import './context-menu.css'

export interface MenuAction {
  readonly label: string
  /** What the item does, said under its label. */
  readonly detail?: string
  readonly onSelect: () => void
  /** Give focus back to where the menu was opened from after choosing (default true). */
  readonly restoreFocus?: boolean
}

/** Where the menu opens, in viewport pixels (its top-left corner). */
export interface MenuAnchor {
  readonly x: number
  readonly y: number
}

/** The space kept between the menu and the edges of the viewport. */
const EDGE_PX = 8

/** `anchor` moved so a `width` × `height` menu stays inside a `viewW` × `viewH` viewport. */
export function placeMenu(
  anchor: MenuAnchor,
  width: number,
  height: number,
  viewW: number,
  viewH: number,
): MenuAnchor {
  const clamp = (value: number, size: number, view: number) =>
    Math.max(EDGE_PX, Math.min(value, view - size - EDGE_PX))
  // Opens upwards from the anchor when there is no room below it.
  const y = anchor.y + height + EDGE_PX > viewH ? anchor.y - height : anchor.y
  return { x: clamp(anchor.x, width, viewW), y: clamp(y, height, viewH) }
}

/** The anchor for a menu opened from the keyboard on `element`: just under its start. */
export function anchorBelow(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + 2 * EDGE_PX, y: rect.bottom }
}

export function ContextMenu(props: {
  /** The menu's accessible name. */
  readonly label: string
  readonly anchor: MenuAnchor
  readonly actions: readonly MenuAction[]
  /** Closes the menu; `restoreFocus` asks for focus to go back to where it was opened from. */
  readonly onClose: (restoreFocus: boolean) => void
  /** A press inside this element is not a press outside the menu (the button that toggles it). */
  readonly owner?: RefObject<Element | null>
}) {
  const { label, anchor, actions, onClose, owner } = props
  const menuRef = useRef<HTMLUListElement>(null)
  const [place, setPlace] = useState<MenuAnchor>(anchor)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const rect = menu.getBoundingClientRect()
    setPlace(placeMenu(anchor, rect.width, rect.height, window.innerWidth, window.innerHeight))
  }, [anchor])

  useEffect(() => {
    menuItems(menuRef.current)[0]?.focus()
  }, [])

  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || owner?.current?.contains(target)) return
      onClose(false)
    }
    const close = () => onClose(false)
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('scroll', outside, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose, owner])

  const choose = (action: MenuAction) => {
    onClose(action.restoreFocus !== false)
    action.onSelect()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onClose(true)
      return
    }
    moveFocus(event, menuRef.current)
  }

  return createPortal(
    <ul
      ref={menuRef}
      className="ch-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <li key={action.label} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="ch-context-item"
            onClick={() => choose(action)}
          >
            <span className="ch-context-label">{action.label}</span>
            {action.detail !== undefined && (
              <span className="ch-context-detail">{action.detail}</span>
            )}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  )
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []
}

/** Arrow keys, Home and End move between the items, wrapping around at the ends. */
function moveFocus(event: KeyboardEvent<HTMLElement>, menu: HTMLElement | null): void {
  const items = menuItems(menu)
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
