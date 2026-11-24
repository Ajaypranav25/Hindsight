/**
 * Open requests wait here until the studio has subscribed to them. Files and links passed at
 * launch (and macOS's open-file events, which can come before the app is even ready) arrive long
 * before the page has loaded; a reload or a crashed page means waiting again.
 */

/** Only the latest requests matter (each one replaces the studio's program), so few are kept. */
export const MAX_QUEUED = 32

export class ReadyQueue<T> {
  private pending: readonly T[] = []
  private ready = false

  constructor(private readonly limit: number = MAX_QUEUED) {}

  get isReady(): boolean {
    return this.ready
  }

  /** What to deliver now: the item itself once the page is ready, otherwise nothing (it waits). */
  push(item: T): readonly T[] {
    if (this.ready) return [item]
    this.pending = [...this.pending, item].slice(-this.limit)
    return []
  }

  /** The page subscribed: returns everything that waited, oldest first. */
  markReady(): readonly T[] {
    this.ready = true
    const waiting = this.pending
    this.pending = []
    return waiting
  }

  /** The page went away (reloaded, crashed); requests wait for it again. */
  reset(): void {
    this.ready = false
  }
}
