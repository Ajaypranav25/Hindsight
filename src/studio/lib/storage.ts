import type { KeyValueStorage } from '../state/types'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Persistence through `localStorage`. Storage is a convenience here: when it is unavailable or
 * throws (private windows, blocked site data, sandboxed previews), reads return null and writes are
 * dropped so the studio keeps working without it.
 */
export function browserStorage(): KeyValueStorage {
  const resolve = (): StorageLike | null => {
    try {
      return (globalThis as { localStorage?: StorageLike }).localStorage ?? null
    } catch {
      return null
    }
  }
  return {
    read(key) {
      try {
        return resolve()?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    write(key, value) {
      try {
        resolve()?.setItem(key, value)
      } catch {
        // Persistence is optional; the in-memory state stays authoritative.
      }
    },
  }
}

/** In-memory storage for tests and for hosts without `localStorage`. */
export function memoryStorage(initial: Readonly<Record<string, string>> = {}): KeyValueStorage {
  const data = new Map(Object.entries(initial))
  return {
    read: (key) => data.get(key) ?? null,
    write: (key, value) => {
      data.set(key, value)
    },
  }
}

/** Reads and validates a JSON value; malformed or invalid data reads as null. */
export function readJson<T>(
  storage: KeyValueStorage,
  key: string,
  isValid: (value: unknown) => value is T,
): T | null {
  const raw = storage.read(key)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeJson(storage: KeyValueStorage, key: string, value: unknown): void {
  storage.write(key, JSON.stringify(value))
}
