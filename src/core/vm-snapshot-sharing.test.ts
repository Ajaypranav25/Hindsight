import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { Program } from './bytecode'
import type { RuntimeDeps, VM, VMSnapshot } from './runtime-types'
import { compileMain, freshVMAt, recordSource, testRuntime } from './testing/recording'
import { digest, liveDigest } from './testing/vm-digest'
import { MachineSnapshot } from './vm-snapshot'

/** Mutation-heavy programs: big lists and records use the persistent-vector path (> 32 slots). */
const PROGRAMS: Record<string, string> = {
  bigList: [
    'var xs = list(0..40)',
    'xs[3] = "three"',
    'xs[39] = [xs[3]]',
    'push(xs, 40)',
    'push(xs, {at: 41})',
    'insert(xs, 10, "ten")',
    'remove(xs, 0)',
    'pop(xs)',
    'insert(xs, 0, -1)',
    'let ys = [0, ...xs, 99]',
    'xs[0] = ys',
    'let sorted = sort([5, 3, 9, 1])',
    'let backwards = reverse(xs)',
    'backwards[1] = sorted',
    'let shallow = copy(xs)',
    'shallow[2] = "two"',
    'while len(xs) > 30 { pop(xs) }',
    'xs[1] = xs',
    'print(len(xs), len(ys), sorted, len(backwards), shallow[2])',
  ].join('\n'),
  bigRecord: [
    'var r = {}',
    'for i in 0..20 { r["k{i}"] = i }',
    'r.k3 = "three"',
    'r.extra = [1, 2]',
    'delete(r, "k5")',
    'r.k5 = "back at the end"',
    'r["k7"] = {inner: r.extra}',
    'let merged = {first: 0, ...r, last: 1}',
    'merged.first = merged',
    'delete(r, "k0")',
    'for k in r { if k == "k9" { r.k9 = "seen" } }',
    'print(len(r), r.k9, keys(merged)[0], merged.k5)',
  ].join('\n'),
  iterators: [
    'var xs = [1, 2, 3]',
    'var log = []',
    'for x in xs {',
    '  if x < 3 { push(xs, x + 10) }',
    '  for y in 0..2 { push(log, x * y) }',
    '}',
    'let r = {a: 1, b: 2, c: 3}',
    'for k in r {',
    '  delete(r, "c")',
    '  push(log, k)',
    '}',
    'print(log)',
  ].join('\n'),
  cells: [
    'fn counter() {',
    '  var n = 0',
    '  let inc = || {',
    '    n = n + 1',
    '    n',
    '  }',
    '  inc',
    '}',
    'let a = counter()',
    'let b = counter()',
    'var fs = [a, b]',
    'for i in 0..4 { fs[i % 2]() }',
    'fn pair() {',
    '  var shared = []',
    '  let add = |v| push(shared, v)',
    '  let get = || shared',
    '  [add, get]',
    '}',
    'let p = pair()',
    'p[0](1)',
    'p[0](2)',
    'print(a(), b(), p[1]())',
  ].join('\n'),
  patchedList: [
    'var xs = list(0..2000)',
    'for i in 0..30 {',
    '  xs[i * 61 % 2000] = -i',
    '  if i % 7 == 0 { push(xs, [i]) }',
    '  if i % 11 == 0 { pop(xs) }',
    '}',
    'print(len(xs), xs[61])',
  ].join('\n'),
  random: [
    'var xs = []',
    'for i in 0..12 { push(xs, random_int(1, 6)) }',
    'seed(7)',
    'xs[0] = random()',
    'print(xs)',
  ].join('\n'),
}

interface Taken {
  readonly program: Program
  readonly runtime: RuntimeDeps
  readonly snapshots: VMSnapshot[]
}

/** Runs `source` in one VM, snapshotting before every `every`-th step and at the end. */
function snapshotsOf(source: string, every = 1): Taken {
  const program = compileMain(source)
  const runtime = testRuntime()
  const vm = newVM(program, runtime)
  const snapshots: VMSnapshot[] = []
  while (vm.status === 'running') {
    if (vm.time % every === 0) snapshots.push(vm.snapshot())
    vm.step()
  }
  expect(vm.status).toBe('finished')
  snapshots.push(vm.snapshot())
  return { program, runtime, snapshots }
}

function newVM(program: Program, runtime: RuntimeDeps): VM {
  return runtime.createVM(program, {
    builtins: runtime.builtins,
    libraryProtos: runtime.libraryProtos,
  })
}

/** Restores `snapshot` in a fresh VM and compares it with a fresh run to the same time. */
function expectRestoresLikeFreshRun(taken: Taken, snapshot: VMSnapshot): void {
  const replica = newVM(taken.program, taken.runtime)
  replica.restore(snapshot)
  const reference = freshVMAt(taken.program, taken.runtime, snapshot.time)
  expect(digest(replica)).toBe(digest(reference))
}

describe('structural sharing between consecutive snapshots (ARCHITECTURE §6.8)', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    test(`${name}: a snapshot before every step restores like a fresh run`, () => {
      // Arrange
      const taken = snapshotsOf(source)

      // Act + Assert: newest first, so later snapshots cannot have helped earlier ones.
      for (const snapshot of taken.snapshots.slice().reverse()) {
        expectRestoresLikeFreshRun(taken, snapshot)
      }
    })
  }

  test('any subset of the snapshots, restored in any order, stays valid (thinning)', () => {
    const taken = snapshotsOf(PROGRAMS.bigList!, 3)
    const count = taken.snapshots.length
    fc.assert(
      fc.property(fc.array(fc.nat(count - 1), { minLength: 1, maxLength: 6 }), (picks) => {
        for (const pick of picks) expectRestoresLikeFreshRun(taken, taken.snapshots[pick]!)
      }),
      { numRuns: 25 },
    )
  })

  test('restoring an old snapshot and branching off leaves the later snapshots intact', () => {
    // Arrange
    const taken = snapshotsOf(PROGRAMS.bigRecord!)
    const middle = taken.snapshots[Math.floor(taken.snapshots.length / 2)]!
    const vm = newVM(taken.program, taken.runtime)

    // Act: a sibling line from the middle, run to the end with snapshots of its own.
    vm.restore(middle)
    const branch: VMSnapshot[] = []
    while (vm.status === 'running') {
      branch.push(vm.snapshot())
      vm.step()
    }

    // Assert
    for (const snapshot of [...branch, ...taken.snapshots].reverse()) {
      expectRestoresLikeFreshRun(taken, snapshot)
    }
  })

  test('an unchanged heap is shared: a second snapshot copies only the roots', () => {
    const run = snapshotsOf('let xs = list(0..5000)\nlet r = {a: xs}\nvar t = 0\nt = 1\nt = 2')
    const last = run.snapshots[run.snapshots.length - 1] as MachineSnapshot
    const previous = run.snapshots[run.snapshots.length - 2] as MachineSnapshot
    expect(previous.size).toBeLessThan(20)
    expect(last.size).toBeLessThan(20)
    expect(last.retainedSince(previous)).toBe(last.size)
    expect(last.retainedSince(null)).toBeGreaterThan(5000)
  })

  test('changing one element of a big list copies one path of its tree, not the list', () => {
    const source = 'var xs = list(0..50000)\nxs[25000] = -1\nxs[49999] = -2\nprint(xs[25000])'
    const taken = snapshotsOf(source)
    const sizes = taken.snapshots.map((snapshot) => snapshot.size)
    expect(Math.max(...sizes)).toBeGreaterThan(50000)
    // After the list exists, a snapshot copies at most one path of the list's tree (a leaf and
    // three inner nodes of up to 32 slots), not the list.
    const afterList = sizes.slice(sizes.indexOf(Math.max(...sizes)) + 1)
    expect(Math.max(...afterList)).toBeLessThan(200)
    for (const snapshot of taken.snapshots.slice(-3)) expectRestoresLikeFreshRun(taken, snapshot)
  })

  test('appending to and popping from a big list copies only its tail', () => {
    const source =
      'var xs = list(0..20000)\nfor i in 0..50 { push(xs, i) }\nfor i in 0..60 { pop(xs) }'
    const taken = snapshotsOf(source)
    const largest = Math.max(...taken.snapshots.map((snapshot) => snapshot.size))
    const late = taken.snapshots.slice(-200).map((snapshot) => snapshot.size)
    expect(largest).toBeGreaterThan(20000)
    expect(Math.max(...late)).toBeLessThan(100)
    expectRestoresLikeFreshRun(taken, taken.snapshots[taken.snapshots.length - 1]!)
    expectRestoresLikeFreshRun(taken, taken.snapshots[taken.snapshots.length - 150]!)
  })

  test('writing fields of a big record copies only the changed entries', () => {
    const source = [
      'var r = {}',
      'for i in 0..3000 { r["k{i}"] = i }',
      'for i in 0..20 { r["k{i * 100}"] = -i }',
      'r.added = 1',
    ].join('\n')
    const taken = snapshotsOf(source, 5)
    const late = taken.snapshots.slice(-20).map((snapshot) => snapshot.size)
    expect(Math.max(...late)).toBeLessThan(100)
    for (const snapshot of taken.snapshots.slice(-25)) expectRestoresLikeFreshRun(taken, snapshot)
  })

  test('garbage is compacted away and every snapshot still restores', () => {
    // Each iteration drops a 64-item list that earlier snapshots captured.
    const source = 'var xs = []\nfor i in 0..1600 {\n  xs = list(0..64)\n  xs[0] = i\n}'
    const taken = snapshotsOf(source, 7)
    const machines = taken.snapshots as MachineSnapshot[]
    const compactions = new Set(machines.map((snapshot) => snapshot.compactedValues))
    expect(compactions.size).toBeGreaterThan(1)
    const last = machines[machines.length - 1]!
    // Without compaction the table would hold every list ever captured (> 1600 * 65 values).
    expect(last.tableValues).toBeLessThan(1600 * 65)
    const sample = [0, 1, machines.length >> 1, machines.length - 2, machines.length - 1]
    for (const index of sample) expectRestoresLikeFreshRun(taken, machines[index]!)
    const compacted = machines.findIndex(
      (s, i) => i > 0 && s.compactedValues !== machines[i - 1]!.compactedValues,
    )
    expectRestoresLikeFreshRun(taken, machines[compacted]!)
    expectRestoresLikeFreshRun(taken, machines[compacted + 1]!)
  })

  test('a change log that grows too long falls back to a full snapshot', () => {
    // 200,000 element writes between two snapshots exceed the log limit (2 × 65,536 pairs).
    const program = compileMain('var xs = list(0..10)\nfor i in 0..200000 { xs[i % 10] = i }')
    const runtime = testRuntime()
    const vm = newVM(program, runtime)
    vm.runUntil(20)
    const first = vm.snapshot() as MachineSnapshot
    vm.runUntil(2_000_000)
    const last = vm.snapshot() as MachineSnapshot
    expect(last.serial).toBe(1)
    expect(last.lineage).not.toBe(first.lineage)
    expect(last.retainedSince(first)).toBe(last.retainedSince(null))
    expectRestoresLikeFreshRun({ program, runtime, snapshots: [] }, last)
  })
})

describe('delta restores (ARCHITECTURE §6.8)', () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    test(`${name}: one VM restoring snapshots in any order and running on matches fresh runs`, () => {
      const taken = snapshotsOf(source, 3)
      const count = taken.snapshots.length
      const moves = fc.array(fc.tuple(fc.nat(count - 1), fc.nat(12)), {
        minLength: 1,
        maxLength: 8,
      })
      fc.assert(
        fc.property(moves, (picks) => {
          const vm = newVM(taken.program, taken.runtime)
          for (const [pick, extra] of picks) {
            const snapshot = taken.snapshots[pick]!
            vm.restore(snapshot)
            vm.runUntil(snapshot.time + extra)
            const reference = freshVMAt(taken.program, taken.runtime, vm.time)
            expect(liveDigest(vm)).toBe(liveDigest(reference))
          }
          // A full snapshot of the end state agrees too (object counter, generator).
          const last = freshVMAt(taken.program, taken.runtime, vm.time)
          expect(digest(vm)).toBe(digest(last))
        }),
        { numRuns: 30 },
      )
    })
  }

  test('objects that did not change between two snapshots keep their identity', () => {
    const taken = snapshotsOf('let xs = list(0..5000)\nvar t = 0\nfor i in 0..20 { t += i }')
    const vm = newVM(taken.program, taken.runtime)
    const late = taken.snapshots[taken.snapshots.length - 1]!
    const earlier = taken.snapshots[taken.snapshots.length - 20]!
    vm.restore(earlier)
    const list = vm.globals.get('xs')
    vm.restore(late)
    expect(vm.globals.get('xs')).toBe(list)
    expect(liveDigest(vm)).toBe(liveDigest(freshVMAt(taken.program, taken.runtime, late.time)))
  })
})

describe('recorder contracts with shared snapshots', () => {
  const MUTATING = [
    'var xs = list(0..300)',
    'var r = {}',
    'for i in 0..300 {',
    '  xs[i] = xs[(i * 7) % 300] + 1',
    '  r["k{i % 40}"] = i',
    '  if i % 50 == 0 { delete(r, "k3") }',
    '}',
    'print(xs[299], len(r))',
  ].join('\n')

  test('seeks in any order agree with fresh runs, with heavy thinning', () => {
    const program = compileMain(MUTATING)
    const runtime = testRuntime()
    const recording = recordSource(MUTATING, { snapshotBudget: 3 })
    const times = [recording.length, 7, 5000, 123, recording.length >> 1, 1, 9000, 4321]
    for (const time of times.filter((t) => t <= recording.length)) {
      const view = recording.stateAt(time)
      const fresh = recordSource(MUTATING, { maxSteps: Math.max(1, time) })
      expect(view.globals).toEqual(fresh.stateAt(Math.min(time, fresh.length)).globals)
      expect(freshVMAt(program, runtime, time).time).toBe(time)
    }
  })

  test('extend resumes from the shared snapshot at N and seeks back into the parent', () => {
    const paused = recordSource(MUTATING, { maxSteps: 3000 })
    const extended = paused.extend(4000)
    const full = recordSource(MUTATING)
    for (const time of [0, 1500, 3000, 4500, 6999]) {
      expect(extended.stateAt(time)).toEqual(full.stateAt(time))
    }
    expect(paused.stateAt(2999)).toEqual(full.stateAt(2999))
  })

  test('a fork after mutations sees its edit in every later seek', () => {
    // Arrange
    const parent = recordSource(MUTATING)
    const time = 2000
    const before = parent.stateAt(time)
    const xs = before.globals.find((global) => global.name === 'xs')!.value
    if (xs.kind !== 'ref') throw new Error('xs is not a list')

    // Act
    const result = parent.fork(time, {
      target: { kind: 'element', objectId: xs.id, index: 299 },
      value: 'edited',
    })
    if (!result.ok) throw new Error(result.error.message)
    const fork = result.recording

    // Assert: seeking back and forth inside the fork goes through its pinned snapshot.
    const lastItem = (t: number, recording = fork) => {
      const list = recording.objectAt(t, xs.id, { offset: 299, limit: 1 })
      if (list?.type !== 'list') throw new Error('not a list')
      return list.items[0]
    }
    for (const t of [time, fork.length, time + 1, time]) {
      expect(lastItem(t)).toEqual({ kind: 'string', value: 'edited' })
    }
    // The loop later reads the edited item into `+ 1`, which fails only in the fork.
    expect(fork.outcome.kind).toBe('error')
    expect(parent.outcome.kind).toBe('finished')
    expect(lastItem(time, parent)).not.toEqual({ kind: 'string', value: 'edited' })
  })
})
