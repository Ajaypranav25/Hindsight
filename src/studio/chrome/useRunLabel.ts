import { useMemo } from 'react'
import { currentPlatform, isApplePlatform, runShortcutLabel } from '../lib/shortcuts'

/** True on Apple platforms (the run shortcut is ⌘ Enter there). */
export function useApplePlatform(): boolean {
  return useMemo(() => isApplePlatform(currentPlatform()), [])
}

/** "Ctrl+Enter" or "⌘ Enter" for this platform. */
export function useRunLabel(): string {
  return runShortcutLabel(useApplePlatform())
}
