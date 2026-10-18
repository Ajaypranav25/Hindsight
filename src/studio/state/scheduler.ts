import type { Scheduler } from './types'

/** The browser's timers. */
export const browserScheduler: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms) as unknown as number,
  clearInterval: (handle) => globalThis.clearInterval(handle),
}

/** A manual clock for tests: time only moves when `advance` is called. */
export class ManualScheduler implements Scheduler {
  private now = 0
  private nextHandle = 1
  private readonly timers = new Map<
    number,
    { due: number; callback: () => void; every: number | null }
  >()

  setTimeout(callback: () => void, ms: number): number {
    return this.add(callback, ms, null)
  }

  setInterval(callback: () => void, ms: number): number {
    return this.add(callback, ms, ms)
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle)
  }

  clearInterval(handle: number): void {
    this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  /** Runs every timer that falls due within the next `ms` milliseconds, in due order. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const next = this.nextDue(end)
      if (!next) break
      const [handle, timer] = next
      this.now = timer.due
      if (timer.every === null) this.timers.delete(handle)
      else this.timers.set(handle, { ...timer, due: timer.due + timer.every })
      timer.callback()
    }
    this.now = end
  }

  private add(callback: () => void, ms: number, every: number | null): number {
    const handle = this.nextHandle++
    this.timers.set(handle, { due: this.now + Math.max(0, ms), callback, every })
    return handle
  }

  private nextDue(end: number) {
    let best: [number, { due: number; callback: () => void; every: number | null }] | null = null
    for (const entry of this.timers) {
      if (entry[1].due <= end && (!best || entry[1].due < best[1].due)) best = entry
    }
    return best
  }
}
