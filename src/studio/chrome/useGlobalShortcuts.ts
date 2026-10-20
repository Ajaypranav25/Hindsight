import { useEffect } from 'react'
import {
  commandForKey,
  focusContextOf,
  getEditorCursorLine,
  runCommand,
  type FocusTarget,
} from '../lib/shortcuts'
import { useStudioActions } from '../state/context'

/**
 * Installs the studio's keyboard shortcuts on the window, in the capture phase so that Ctrl+Enter
 * and the function keys win over the editor's own key bindings. Handled keys are consumed
 * (preventDefault and stopPropagation); everything else, including all plain typing, passes on.
 */
export function useGlobalShortcuts(): void {
  const actions = useStudioActions()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      const focus = focusContextOf(target as FocusTarget | null, document)
      const command = commandForKey(event, focus)
      if (!command || !runCommand(command, actions, getEditorCursorLine())) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actions])
}
