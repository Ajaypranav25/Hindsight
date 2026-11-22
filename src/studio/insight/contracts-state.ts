/**
 * Which function the "Suggest contracts" card is open for. Kept apart from the studio store: the
 * card is opened from the editor and from the call stack and lives only as long as its run is
 * shown (the card checks that), so nothing else needs to know about it. Updates replace the state.
 */
import { useSyncExternalStore } from 'react'
import { getEditorCursorLine, subscribeEditorCursorLine } from '../lib/shortcuts'
import type { ContractsTarget } from './contracts-model'

let target: ContractsTarget | null = null
const listeners = new Set<() => void>()

function publish(next: ContractsTarget | null): void {
  if (next === target) return
  target = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function openContracts(next: ContractsTarget): void {
  publish(next)
}

export function closeContracts(): void {
  publish(null)
}

export function contractsTarget(): ContractsTarget | null {
  return target
}

/** The function the card is open for (null when it is closed). */
export function useContractsTarget(): ContractsTarget | null {
  return useSyncExternalStore(subscribe, contractsTarget, contractsTarget)
}

/** The editor's cursor line, kept current. */
export function useEditorCursorLine(): number | null {
  return useSyncExternalStore(subscribeEditorCursorLine, getEditorCursorLine, getEditorCursorLine)
}
