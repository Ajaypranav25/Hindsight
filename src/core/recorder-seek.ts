/**
 * Seeking (ARCHITECTURE §7.1.5): one replay VM (hooks off) is positioned at a time by restoring the
 * latest snapshot at or before it and running on. A forward seek within reach runs on from the
 * current position without restoring. Recently built views are cached in a small LRU.
 */
import type { Program } from './bytecode'
import type { RuntimeDeps, VM } from './runtime-types'
import type { SnapshotSchedule } from './recorder-session'

export class Seeker {
  private vm: VM | null = null

  constructor(
    private readonly program: Program,
    private readonly runtime: RuntimeDeps,
    private readonly seed: number,
    private readonly schedule: SnapshotSchedule,
  ) {}

  /** The replay VM positioned at `time` (valid until the next call). */
  positionAt(time: number): VM {
    const snapshot = this.schedule.latestAtOrBefore(time)
    let vm = this.vm
    if (vm === null) {
      vm = this.runtime.createVM(this.program, {
        builtins: this.runtime.builtins,
        libraryProtos: this.runtime.libraryProtos,
        seed: this.seed,
      })
      this.vm = vm
    }
    const canRunOn = vm.status === 'running' && vm.time <= time && vm.time >= snapshot.time
    if (!canRunOn) vm.restore(snapshot.snapshot)
    vm.runUntil(time)
    return vm
  }
}

/** A tiny least-recently-used cache. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done !== true) this.entries.delete(oldest.value)
    }
  }
}
