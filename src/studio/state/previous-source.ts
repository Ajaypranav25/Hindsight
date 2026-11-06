/**
 * Keeping the user's own program when a share link or an example replaces it. The studio stores
 * one program per browser, so without this a link could silently destroy someone's work.
 *
 * Text that arrived with a link or an example and has not been edited since is "delivered": it is
 * not the user's work, so it is never kept, and in particular never pushes out a kept program (a
 * page could otherwise open two links in a row to flush the user's program out).
 */
import { STORAGE_KEYS } from './defaults'
import type { Example, KeyValueStorage, Notice } from './types'

export const KEPT_AFTER_LINK_NOTICE: Notice = {
  text: 'Opened a shared program. Your previous program was kept.',
  tone: 'info',
  action: 'restore-previous',
}

export const KEPT_AFTER_EXAMPLE_NOTICE: Notice = {
  text: 'Your previous program was kept.',
  tone: 'info',
  action: 'restore-previous',
}

/** True for text the user wrote: not blank and not an unchanged gallery example. */
export function isOwnProgram(source: string, examples: readonly Example[]): boolean {
  return source.trim() !== '' && !examples.some((example) => example.source === source)
}

/** `kept`: stored. `not-needed`: nothing of the user's would be lost. `failed`: storage refused. */
export type KeepResult = 'kept' | 'not-needed' | 'failed'

export interface Replacement {
  /** The program about to be replaced (null when none was stored). */
  readonly current: string | null
  /** True when `current` arrived with a link or an example and was not edited since. */
  readonly delivered: boolean
  /** The program replacing it. */
  readonly incoming: string
}

/**
 * Stores the program about to be replaced as the previous program when it is work the user wrote.
 * The copy is read back, since browser storage can refuse writes (a full quota) without throwing.
 */
export function keepPreviousSource(
  storage: KeyValueStorage,
  examples: readonly Example[],
  replacement: Replacement,
): KeepResult {
  const { current, delivered, incoming } = replacement
  if (current === null || delivered || current === incoming || !isOwnProgram(current, examples))
    return 'not-needed'
  storage.write(STORAGE_KEYS.previousSource, current)
  return storage.read(STORAGE_KEYS.previousSource) === current ? 'kept' : 'failed'
}
