import { describe, expect, test } from 'vitest'
import type { VM, VMSnapshot } from './runtime-types'
import { RETAINED_VALUES_LIMIT, SnapshotSchedule } from './recorder-session'

/** A stand-in VM whose snapshots report a chosen size and whose work is set by the test. */
interface FakeVM extends VM {
  /** Positions the VM at `time` after `work` units of work (by default one per step). */
  at(time: number, work?: number): FakeVM
}

function fakeVM(size: () => number, extra: Partial<VMSnapshot> = {}): FakeVM {
  let time = 0
  let work = 0
  const vm = {
    get work() {
      return work
    },
    snapshot: (): VMSnapshot => ({ time, size: size(), ...extra }),
    at(t: number, w = t) {
      time = t
      work = w
      return vm
    },
  }
  return vm as unknown as FakeVM
}

/** Drives the schedule like the recorder does, over `steps` steps. */
function drive(
  schedule: SnapshotSchedule,
  steps: number,
  size: () => number,
  workAt: (t: number) => number = (t) => t,
): number[] {
  const vm = fakeVM(size)
  for (let t = 0; t < steps; t++) {
    vm.at(t, workAt(t))
    if (vm.work >= schedule.next) schedule.take(vm, t)
  }
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
    schedule.take(vm.at(0), 0)
    schedule.take(vm.at(schedule.next), schedule.next)
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
    copy.take(vm.at(256), 256)
    copy.take(vm.at(512), 512)
    expect(schedule.list.length).toBe(1)
    expect(copy.list.map((entry) => entry.time)).toEqual([0, 512])
  })

  test('a snapshot that is costly to restore spaces the next one out to twice that cost', () => {
    // Copying 10 values is cheap, but a restore rebuilds 1,000: replay may cost up to 2,000.
    const schedule = SnapshotSchedule.start(512)
    const vm = fakeVM(() => 10, { restoreSize: 1000 })
    schedule.take(vm.at(0), 0)
    expect(schedule.next).toBe(2048)
  })

  test('a step that does a lot of work brings the next snapshot forward', () => {
    const schedule = SnapshotSchedule.start(512)
    // Step 99 sorts a huge list: 10,000 units of work in one step.
    const times = drive(
      schedule,
      600,
      () => 10,
      (t) => (t >= 100 ? t + 10_000 : t),
    )
    // Due at work 256, reached at time 100; then due at 10,100 + 256 → 10,496, i.e. time 496.
    expect(times).toEqual([0, 100, 496])
  })

  test('values shared between snapshots are retained once, also after thinning', () => {
    // Snapshot k holds 1,000 values from the first one plus 10 copied by each one since.
    let serial = 0
    const vm = {
      work: 0,
      snapshot(): VMSnapshot {
        const mine = serial++
        return {
          time: mine,
          size: mine === 0 ? 1000 : 10,
          retainedSince(earlier) {
            const before = (earlier as { serial?: number } | null)?.serial
            return before === undefined ? 1000 + 10 * mine : 10 * (mine - before)
          },
          serial: mine,
        } as VMSnapshot
      },
    } as unknown as VM
    const schedule = SnapshotSchedule.start(4)
    for (let t = 0; t < 5; t++) schedule.add(t, vm.snapshot(), t * 1000)
    // 0..4 thinned to 0, 2, 4: 1,000 + 20 + 20, as if 1 and 3 still counted.
    expect(schedule.list.map((entry) => entry.time)).toEqual([0, 2, 4])
    expect(schedule.retainedValues).toBe(1040)
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
