import { useId, useState, type KeyboardEvent } from 'react'
import { useStudio } from '../state/context'

/** "in library: map" — the pen is inside library code, which the editor does not show. */
export function LibraryChip(props: { name: string }) {
  const [open, setOpen] = useState(false)
  const justMyCode = useStudio((s) => s.settings.justMyCode)
  const id = useId()
  const close = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
    }
  }
  return (
    <div className="ed-lib" onKeyDown={close}>
      <button
        type="button"
        className="ed-lib-chip"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ed-lib-label">in library</span>
        <span className="ed-lib-name">{props.name}</span>
      </button>
      {open && (
        <p className="ed-lib-note" id={id}>
          The pen is inside <code>{props.name}</code>, a library function, so nothing is highlighted
          here.{' '}
          {justMyCode
            ? 'Just-my-code is on: stepping skips library code, and Step out (F7) returns to your program.'
            : 'Turn on just-my-code in Settings to step over library code, or Step out (F7) to return to your program.'}
        </p>
      )}
    </div>
  )
}
