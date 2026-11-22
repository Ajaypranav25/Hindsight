import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { Recording, ScheduleOptions, StateView } from './api-types'
import { callTree, type CallNode } from './calls'
import { record } from './index'
import { buildStateView } from './inspector'
import { ProtoTable } from './inspector-location'
import { BANK_RACE, PIPELINE, compileTasks, libraryRuntime, tasksVM } from './testing/tasks'

/** Main receives three squares from a producer task over an unbuffered channel. */
const HANDOFF = `let ch = channel()
fn producer(n) {
  for i in 0..n {
    send(ch, i)
  }
  return "done"
}
fn square(x) { x * x }
let p = spawn(producer, 3)
var total = 0
for i in 0..3 {
  total = total + square(recv(ch))
}
print(total, wait(p))`

/** A worker task that calls a helper and yields between calls. */
const TASK_CALLS = `let ch = channel(1)
fn sq(x) { x * x }
fn worker(n) {
  var s = 0
  for i in 0..n {
    s = s + sq(i)
    yield()
  }
  send(ch, s)
  return s
}
let w = spawn(worker, 3)
yield()
let m = sq(10)
print(recv(ch) + m, wait(w))`

const RANDOM: ScheduleOptions = { policy: 'random', quantum: 2, seed: 5 }

function recordTasks(source: string, schedule?: ScheduleOptions, snapshotBudget?: number) {
  return record(compileTasks(source), { schedule, snapshotBudget })
}

/** The first time at or after `from` that satisfies `predicate`. */
function firstTime(recording: Recording, predicate: (t: number) => boolean, from = 0): number {
  for (let t = from; t <= recording.length; t++) if (predicate(t)) return t
  throw new Error('no such time')
}

function lineAt(recording: Recording, t: number): number | undefined {
  return recording.locationAt(t)?.stmtLine
}

describe('the task series', () => {
  test('a program without tasks has no task series and no task views', () => {
    // Arrange, Act
    const recording = recordTasks('var s = 0\nfor i in 0..3 { s = s + i }\nprint(s)')

    // Assert
    expect(recording.taskSeries()).toBeNull()
    expect(recording.taskAt(0)).toBe(1)
    expect(recording.taskAt(recording.length)).toBe(1)
    expect(recording.stateAt(3).tasks).toBeUndefined()
  })

  test('the series names the task that runs each step, and frames are that task’s', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)

    // Act
    const series = recording.taskSeries()!
    const producerStep = series.indexOf(2)

    // Assert
    expect(series.length).toBe(recording.length)
    expect(new Set(series)).toEqual(new Set([1, 2]))
    expect(recording.taskAt(producerStep)).toBe(2)
    expect(recording.stateAt(producerStep).frames.map((frame) => frame.name)).toEqual(['producer'])
    expect(recording.stateAt(0).frames.map((frame) => frame.name)).toEqual(['<top level>'])
  })

  test('a state lists every task with its status, wait and frames', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)
    const t = firstTime(recording, (u) => recording.stateAt(u).tasks?.[0]?.status === 'blocked')

    // Act
    const tasks = recording.stateAt(t).tasks!

    // Assert
    expect(tasks.map((task) => [task.id, task.name, task.status, task.current])).toEqual([
      [1, 'main', 'blocked', false],
      [2, 'producer', 'runnable', true],
    ])
    expect(tasks[0]!.wait).toEqual({ kind: 'recv', channelId: expect.any(Number) })
    expect(tasks[0]!.frames.map((frame) => [frame.name, frame.line])).toEqual([['<top level>', 12]])
    expect(tasks[1]!.frames[0]!.name).toBe('producer')
  })

  test('a finished task shows its result, even without a handle', () => {
    // Arrange
    const recording = recordTasks('spawn(fn() { [1, 2] })\nyield()\nprint("end")')

    // Act
    const task = recording.stateAt(recording.length).tasks![1]!
    const result = task.result

    // Assert
    expect(task.status).toBe('done')
    expect(result).toEqual({ kind: 'ref', id: expect.any(Number), type: 'list', preview: '[1, 2]' })
    const id = result?.kind === 'ref' ? result.id : -1
    expect(recording.objectAt(recording.length, id)).not.toBeNull()
  })

  test('a task left waiting when main ends is listed in the outcome and the last state', () => {
    // Arrange, Act
    const recording = recordTasks('let ch = channel()\nspawn(fn() { recv(ch) })\nyield()\nprint(1)')

    // Assert
    expect(recording.outcome).toEqual({
      kind: 'finished',
      unfinishedTasks: [
        {
          id: 2,
          name: 'lambda',
          status: 'blocked',
          wait: { kind: 'recv', channelId: expect.any(Number) },
        },
      ],
    })
    expect(recording.stateAt(recording.length).tasks![1]!.status).toBe('blocked')
  })

  test('task switches say who ran before and after and whether the first waits', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)
    const series = recording.taskSeries()!

    // Act
    const switches = recording.taskSwitches()

    // Assert
    expect(switches.length).toBeGreaterThan(2)
    for (const each of switches) {
      expect(each.from).toBe(series[each.time - 1])
      expect(each.to).toBe(recording.taskAt(each.time))
      expect(each.from).not.toBe(each.to)
    }
    expect(switches[0]).toMatchObject({ from: 1, to: 2, state: 'blocked' })
    expect(switches.at(-1)).toMatchObject({ from: 2, to: 1, state: 'done' })
    expect(recordTasks('print(1)').taskSwitches()).toEqual([])
  })

  test('forks and extensions keep the switches of their own steps', () => {
    // Arrange
    const whole = record(compileTasks(PIPELINE), { schedule: RANDOM })
    const paused = record(compileTasks(PIPELINE), { schedule: RANDOM, maxSteps: 120 })

    // Act
    const extended = paused.extend(1_000_000)
    const again = paused.extend(1_000_000)
    const forked = whole.fork(150, { target: { kind: 'global', name: 'jobs' }, value: 1 })

    // Assert
    expect(paused.taskSwitches().every((each) => each.time <= 120)).toBe(true)
    expect(extended.taskSwitches()).toEqual(whole.taskSwitches())
    expect(again.taskSwitches()).toEqual(whole.taskSwitches())
    const before = (switches: readonly { time: number }[]) =>
      switches.filter((each) => each.time <= 150)
    expect(forked.ok && before(forked.recording.taskSwitches())).toEqual(
      before(whole.taskSwitches()),
    )
  })

  test('a what-if fork that never spawns has no task series', () => {
    // Arrange
    const recording = recordTasks('var go = true\nlet x = 1\nif go { spawn(fn() { print(2) }) }')
    const t = firstTime(recording, (u) => lineAt(recording, u) === 2)

    // Act
    const forked = recording.fork(t, { target: { kind: 'global', name: 'go' }, value: false })

    // Assert
    expect(recording.taskSeries()).not.toBeNull()
    expect(forked.ok && forked.recording.taskSeries()).toBeNull()
  })
})

describe('provenance with tasks (ARCHITECTURE §7.3)', () => {
  const SHARED = `fn main() {
  var seen = 0
  let t = spawn(fn(k) {
    seen = seen + k
  }, 5)
  wait(t)
  seen = seen + 1
  print(seen)
}
main()`

  test('a captured variable written by another task traces back to that task’s write', () => {
    // Arrange
    const recording = recordTasks(SHARED)
    const before = firstTime(
      recording,
      (u) => lineAt(recording, u) === 7 && recording.taskAt(u) === 1,
    )
    const local = recording
      .stateAt(before)
      .frames.at(-1)!
      .locals.find((l) => l.name === 'seen')!

    // Act
    const origin = recording.origin(local.target, before)
    const history = recording.history(local.target, before)

    // Assert
    expect(origin?.value).toBe(5)
    expect(recording.taskAt(origin!.time)).toBe(2)
    expect(history.events.map((event) => [event.kind, event.value])).toEqual([
      ['declare', 0],
      ['write', 5],
      ['write', 6],
    ])
    expect(history.events.map((event) => recording.taskAt(event.time))).toEqual([1, 2, 1])
  })

  test('a task’s own locals keep their history in that task', () => {
    // Arrange
    const recording = recordTasks(BANK_RACE, RANDOM)
    const series = recording.taskSeries()!
    const t = firstTime(recording, (u) => series[u] === 3 && lineAt(recording, u) === 6)
    const local = recording
      .stateAt(t)
      .frames.at(-1)!
      .locals.find((l) => l.name === 'b')!

    // Act
    const events = recording.history(local.target, t).events

    // Assert
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) expect(series[event.time]).toBe(3)
  })
})

describe('seeking with tasks (ARCHITECTURE §10.3)', () => {
  function referenceView(schedule: ScheduleOptions, recording: Recording, t: number) {
    const program = recording.program
    const vm = tasksVM(program, schedule)
    vm.runUntil(t)
    const outcome = recording.outcome
    return buildStateView(
      vm,
      { table: new ProtoTable(program, libraryRuntime().libraryProtos), heapLimit: 250 },
      {
        time: t,
        location: recording.locationAt(t),
        outputCount: recording.outputCountAt(t),
        error: t === recording.length && outcome.kind === 'error' ? outcome.error : null,
      },
    )
  }

  function expectSameView(actual: StateView, expected: StateView): void {
    expect(actual).toEqual(expected)
    expect([...actual.heap.keys()]).toEqual([...expected.heap.keys()])
  }

  for (const [name, source] of [
    ['pipeline', PIPELINE],
    ['bank race', BANK_RACE],
  ] as const) {
    test(`${name}: random-order seeks equal a fresh run to t under the same schedule`, () => {
      // Arrange
      const recording = recordTasks(source, RANDOM, 3)
      const n = recording.length

      // Act, Assert
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: n }), { minLength: 1, maxLength: 10 }),
          (times) => {
            for (const t of times) {
              expectSameView(recording.stateAt(t), referenceView(RANDOM, recording, t))
              const current = recording.stateAt(t).tasks?.find((task) => task.current)
              if (current !== undefined) expect(current.id).toBe(recording.taskAt(t))
            }
          },
        ),
        { numRuns: 15 },
      )
    })
  }
})

describe('navigation with tasks (ARCHITECTURE §7.2)', () => {
  test('step over, into and out stay in the task running at the start', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)
    const start = firstTime(
      recording,
      (u) => recording.taskAt(u) === 2 && lineAt(recording, u) === 4,
    )

    // Act
    const results = (['over', 'into'] as const).flatMap((kind) => [
      recording.step(start, kind, 'forward'),
      recording.step(start, kind, 'backward'),
    ])

    // Assert
    for (const u of results) expect(recording.taskAt(u)).toBe(2)
    expect(lineAt(recording, recording.step(start, 'over', 'forward'))).toBe(3)
  })

  test('with allTasks, a step may land in another task', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)
    const switches = firstTime(
      recording,
      (u) => recording.taskAt(u) === 2 && recording.taskAt(u + 1) === 1,
    )
    const start = recording.step(switches + 1, 'into', 'backward', { allTasks: true })

    // Act
    const within = recording.step(start, 'into', 'forward')
    const across = recording.step(start, 'into', 'forward', { allTasks: true })

    // Assert
    expect(recording.taskAt(start)).toBe(2)
    expect(recording.taskAt(within)).toBe(2)
    expect(recording.taskAt(across)).toBe(1)
  })

  test('stepping past a task’s last step goes to the step after it', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)
    const series = recording.taskSeries()!
    const last = series.lastIndexOf(2)
    const first = series.indexOf(2)

    // Act
    const forward = recording.step(last, 'out', 'forward')
    const backward = recording.step(first, 'out', 'backward')

    // Assert
    expect(forward).toBe(last + 1)
    expect(backward).toBe(first - 1)
  })

  test('continue stops at a breakpoint in any task', () => {
    // Arrange
    const recording = recordTasks(HANDOFF)

    // Act
    const hit = recording.continue(0, 'forward', new Set([4]))

    // Assert
    expect(recording.taskAt(hit)).toBe(2)
    expect(lineAt(recording, hit)).toBe(4)
  })
})

describe('the call tree with tasks (ARCHITECTURE §7.6)', () => {
  function named(nodes: readonly CallNode[]): [string, number | undefined, number][] {
    return nodes.map((node) => [node.name, node.task, node.depth])
  }

  test('each spawned task’s function call is a child of the root, in entry order', () => {
    // Arrange
    const tree = callTree(recordTasks(HANDOFF))

    // Act
    const children = tree.children(tree.root)

    // Assert
    expect(named(children)).toEqual([
      ['producer', 2, 1],
      ['square', 1, 1],
      ['square', 1, 1],
      ['square', 1, 1],
    ])
    expect(children.map((child) => child.outcome)).toEqual(Array(4).fill('returned'))
  })

  test('a task’s calls hang under its function call and read their own results', () => {
    // Arrange
    const tree = callTree(recordTasks(TASK_CALLS))

    // Act
    const [worker, mainSq] = tree.children(tree.root)
    const inner = tree.children(worker!)

    // Assert
    expect(named([worker!, mainSq!])).toEqual([
      ['worker', 2, 1],
      ['sq', 1, 1],
    ])
    expect(named(inner)).toEqual(Array(3).fill(['sq', 2, 2]))
    expect(inner.map((call) => tree.details(call).result?.text)).toEqual(['0', '1', '4'])
    expect(tree.details(worker!).result?.text).toBe('5')
    expect(tree.details(worker!).args.map((arg) => arg.text)).toEqual(['3'])
    expect(tree.details(mainSq!).result?.text).toBe('100')
    expect(tree.parent(inner[1]!)).toBe(worker)
    expect(tree.size(worker!)).toBe(4)
  })

  test('under preemption, every call still reads its own result', () => {
    // Arrange
    const tree = callTree(recordTasks(TASK_CALLS, RANDOM))

    // Act
    const results = [...tree.calls()]
      .filter((call) => call.name === 'sq')
      .map((call) => tree.details(call).result?.text)

    // Assert
    expect(results.sort()).toEqual(['0', '1', '100', '4'])
  })

  test('the innermost call at a time is the running task’s', () => {
    // Arrange
    const recording = recordTasks(TASK_CALLS)
    const tree = callTree(recording)
    const inTaskSq = firstTime(
      recording,
      (u) => recording.taskAt(u) === 2 && recording.locationAt(u)?.functionName === 'sq',
    )
    const inMain = firstTime(recording, (u) => recording.taskAt(u) === 1, inTaskSq)

    // Act
    const taskCall = tree.callAt(inTaskSq)
    const mainCall = tree.callAt(inMain)

    // Assert
    expect([taskCall.name, taskCall.task]).toEqual(['sq', 2])
    expect(mainCall.task).toBe(1)
    expect(tree.call(taskCall.entry)).toBe(taskCall)
  })

  test('calls of a task still waiting at the end are unfinished', () => {
    // Arrange
    const tree = callTree(
      recordTasks('let ch = channel()\nfn stuck() { recv(ch) }\nspawn(stuck)\nyield()'),
    )

    // Act
    const [stuck] = tree.children(tree.root)

    // Assert
    expect([stuck!.name, stuck!.outcome, tree.root.outcome]).toEqual([
      'stuck',
      'unfinished',
      'returned',
    ])
    expect(tree.details(stuck!).result).toBeNull()
  })

  test('the failing task’s calls raised; the failure is at its innermost call', () => {
    // Arrange
    const recording = recordTasks('fn bad(x) { x + nil }\nlet t = spawn(bad, 1)\nwait(t)')
    const tree = callTree(recording)

    // Act
    const failing = tree.callAt(recording.length)

    // Assert
    expect([failing.name, failing.task, failing.outcome]).toEqual(['bad', 2, 'raised'])
    expect(tree.root.outcome).toBe('raised')
  })
})
