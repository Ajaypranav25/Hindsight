import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export interface Popover<T extends HTMLElement> {
  readonly open: boolean
  readonly toggle: () => void
  readonly show: () => void
  /** Closes; moves focus back to the trigger unless `restoreFocus` is false. */
  readonly close: (restoreFocus?: boolean) => void
  /** The element wrapping trigger and popover: clicks outside it close the popover. */
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly triggerRef: RefObject<T | null>
}

/** Open state for a popover: closes on Escape (refocusing the trigger) and on outside clicks. */
export function usePopover<T extends HTMLElement = HTMLButtonElement>(): Popover<T> {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<T | null>(null)

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])
  const toggle = useCallback(() => setOpen((value) => !value), [])
  const show = useCallback(() => setOpen(true), [])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  return { open, toggle, show, close, rootRef, triggerRef }
}
