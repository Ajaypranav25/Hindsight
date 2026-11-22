/**
 * The query bar's Examples button (ARCHITECTURE §11.3): a menu with one query per form, written
 * with the program's own names; choosing one fills the field and runs it.
 */
import { useRef, useState } from 'react'
import { anchorBelow, ContextMenu, type MenuAction, type MenuAnchor } from '../chrome/ContextMenu'
import type { QueryExample } from './query-examples'

export function QueryExamples(props: {
  readonly examples: readonly QueryExample[]
  readonly onTry: (example: QueryExample) => void
}) {
  const { examples, onTry } = props
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  if (examples.length === 0) return null
  const close = (restoreFocus: boolean) => {
    setAnchor(null)
    if (restoreFocus) button.current?.focus()
  }
  const toggle = () => {
    if (anchor !== null || button.current === null) return setAnchor(null)
    setAnchor(anchorBelow(button.current))
  }
  const actions: MenuAction[] = examples.map((example) => ({
    label: example.text,
    detail: example.detail,
    code: true,
    // The field takes focus with the example in it.
    restoreFocus: false,
    onSelect: () => onTry(example),
  }))
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ch-button ch-button-small"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        // Not just "Examples": the header's program picker has that name.
        aria-label="Query examples"
        title="Example queries written with this program's names"
        onClick={toggle}
      >
        Examples
      </button>
      {anchor !== null && (
        <ContextMenu
          label="Example queries"
          anchor={anchor}
          actions={actions}
          onClose={close}
          owner={button}
        />
      )}
    </>
  )
}
