import { describe, expect, test } from 'vitest'
import type { VM, VMSnapshot } from './runtime-types'
import { RETAINED_VALUES_LIMIT, SnapshotSchedule } from './recorder-session'

/** A stand-in VM whose snapshots report a chosen size. */
function fakeVM(size: () => number): VM {
  let time = 0
  const vm = {
    snapshot: (): VMSnapshot => ({ time, size: size() }),
    setTime(t: number) {
      time = t
    },
  }
  return vm as unknown as VM
}

/** Drives the schedule like the recorder does, over `steps` steps. */
function drive(schedule: SnapshotSchedule, steps: number, size: () => number): number[] {
  const vm = fakeVM(size)
  for (let t = 0; t < steps; t++) if (t >= schedule.next) schedule.take(vm, t)
  return schedule.list.map((entry) => entry.time)
}

describe('snapshot cadence (ARCHITECTURE §7.1.4)', () => {
  test('small states are snapshotted every interval, starting at time 0', () => {
    const schedule = SnapshotSchedule.start(512)
    expect(drive(schedule, 1000, () => 10)).toEqual([0, 256, 512, 768])
  })

  test('large states wait at least four times their size, rounded up to the interval', () => {
    const schedule = SnapshotSchedule.start(512)
    // 4 * 100 = 400 → next at 512, then 512 + 400 = 912 → 1024.
    expect(drive(schedule, 1100, () => 100)).toEqual([0, 512, 1024])
  })

  test('over the count budget, every other snapshot is dropped and the interval doubles', () => {
    const schedule = SnapshotSchedule.start(4)
    const times = drive(schedule, 256 * 5 + 1, () => 1)
    // 0, 256, 512, 768, 1024 → thinned to 0, 512, 1024 with interval 512.
    expect(times).toEqual([0, 512, 1024])
    expect(schedule.currentInterval).toBe(512)
    expect(schedule.next).toBe(1536)
  })

  test('over the retained-size budget, snapshots are thinned too, keeping time 0', () => {
    const schedule = SnapshotSchedule.start(512)
    const huge = RETAINED_VALUES_LIMIT / 2 + 1
    const vm = fakeVM(() => huge)
    schedule.take(vm, 0)
    schedule.take(vm, schedule.next)
    expect(schedule.list.map((entry) => entry.time)).toEqual([0])
    expect(schedule.currentInterval).toBe(512)
  })

  test('taking a snapshot twice at the same time keeps one and still advances', () => {
    const schedule = SnapshotSchedule.start(512)
    const vm = fakeVM(() => 1)
    schedule.take(vm, 0)
    schedule.take(vm, 0)
    expect(schedule.list.length).toBe(1)
    expect(schedule.next).toBe(256)
  })

  test('clones are independent', () => {
    const schedule = SnapshotSchedule.start(2)
    const vm = fakeVM(() => 1)
    schedule.take(vm, 0)
    const copy = schedule.clone()
    copy.take(vm, 256)
    copy.take(vm, 512)
    expect(schedule.list.length).toBe(1)
    expect(copy.list.map((entry) => entry.time)).toEqual([0, 512])
  })

  test('the latest snapshot at or before a time', () => {
    const schedule = SnapshotSchedule.start(512)
    drive(schedule, 600, () => 1)
    expect(schedule.latestAtOrBefore(0).time).toBe(0)
    expect(schedule.latestAtOrBefore(511).time).toBe(256)
    expect(schedule.latestAtOrBefore(10_000).time).toBe(512)
    expect(() => SnapshotSchedule.start(1).latestAtOrBefore(3)).toThrow()
  })
})
