import { describe, expect, test } from 'vitest'
import type { Recording, ScheduleOptions } from './api-types'
import { answer, question, startFinder, verdict } from './bug-finder'
import { callTree } from './calls'
import { dependenceOf } from './dependence'
import { compile, record } from './index'
import { solveInverse } from './inverse'
import { contractOracle } from './oracle'
import { queryRecording } from './query'
import { repairSearch } from './repair'
import { backwardSlice, errorSlice, SLICE_TASKS_PROBLEM, sliceProblem } from './slice'
import { sweep } from './sweep'
import { compileTasks } from './testing/tasks'
import { whyNot } from './why-not'

const RANDOM: ScheduleOptions = { policy: 'random', quantum: 3, seed: 9 }

/** A worker task sums squares through a helper that is off by one. */
const WRONG_SQUARES = `fn sq(x) {
  x * x + 1
}
fn worker(n) {
  var s = 0
  for i in 0..n {
    s = s + sq(i)
  }
  return s
}
let w = spawn(worker, 3)
print(wait(w))`

function recordTasks(source: string, schedule?: ScheduleOptions): Recording {
  return record(compileTasks(source), { schedule })
}

describe('analyses that refuse programs with tasks', () => {
  test('slices and the dependence graph are not built, and say why', () => {
    // Arrange
    const recording = recordTasks('fn f() { 1 / 0 }\nwait(spawn(f))')

    // Act
    const slice = backwardSlice(recording, recording.length)

    // Assert
    expect(slice).toBeNull()
    expect(errorSlice(recording)).toBeNull()
    expect(dependenceOf(recording)).toBeNull()
    expect(sliceProblem(recording)).toBe(SLICE_TASKS_PROBLEM)
    expect(sliceProblem(recordTasks('print(1)'))).toBeNull()
  })

  test('the inverse what-if refuses with a reason', () => {
    // Arrange
    const recording = recordTasks('let n = 4\nwait(spawn(fn() { print(n * 2) }))')

    // Act
    const result = solveInverse(recording, { kind: 'output', index: 0, text: '10' })

    // Assert
    expect(result.solutions).toEqual([])
    expect(result.problem).toMatch(/not available for programs with tasks/)
  })
})

describe('analyses that work with tasks', () => {
  test('why-not explains a guard inside a task, read in that task', () => {
    // Arrange
    const source = `fn worker(n) {
  yield()
  if n > 5 {
    print("big")
  }
  return n
}
let t = spawn(worker, 2)
var k = 0
while k < 20 { k = k + 1 }
print(wait(t))`
    const recording = recordTasks(source, RANDOM)

    // Act
    const why = whyNot(recording, 4)

    // Assert
    expect(why).toMatchObject({ kind: 'guard', construct: 'if', line: 4, value: 'false' })
  })

  test('the bug finder narrows a wrong result down to a helper called in a task', () => {
    // Arrange
    const tree = callTree(recordTasks(WRONG_SQUARES))
    let state = startFinder(tree, tree.root, { justMyCode: true })
    const asked: string[] = []

    // Act
    for (let call = question(state); call !== null; call = question(state)) {
      const details = tree.details(call)
      asked.push(`${call.name} ${details.result?.text}`)
      const right =
        call.name === 'sq'
          ? details.result?.text === String(Number(details.args[0]!.text) ** 2)
          : false
      state = answer(state, right ? 'right' : 'wrong')
    }
    const result = verdict(state)

    // Assert
    expect(asked[0]).toBe('worker 8')
    expect(result.kind === 'found' && [result.call.name, result.call.task]).toEqual(['sq', 2])
  })

  test('the contract oracle answers for calls in a task', () => {
    // Arrange
    const source = `fn sq(x)
  ensures result == x * x
{
  x * x + 1
}
fn worker() { sq(3) }
print(wait(spawn(worker)))`
    const recording = recordTasks(source)
    const tree = callTree(recording)

    // Act
    const failing = tree.callAt(recording.length)
    const auto = contractOracle(recording, tree)(failing)

    // Assert
    expect([failing.name, failing.task]).toEqual(['sq', 2])
    expect(auto).toMatchObject({ answer: 'wrong' })
  })

  test('calls(...) queries judge each call in its own task', () => {
    // Arrange
    const recording = recordTasks(WRONG_SQUARES, RANDOM)

    // Act
    const outcome = queryRecording(recording, 'calls(sq) where ret > 1')

    // Assert
    expect(
      outcome.ok && outcome.result.kind === 'calls' && outcome.result.calls.map((c) => c.text),
    ).toEqual(['sq(x = 1) returned 2', 'sq(x = 2) returned 5'])
  })

  test('a repair search records its mutants under the run’s schedule', () => {
    // Arrange
    const source = `fn half(x) {
  10 / (x - 2)
}
let t = spawn(half, 2)
print(wait(t))`
    const recording = recordTasks(source, RANDOM)
    const tools = {
      compile,
      record: (program: Parameters<typeof record>[0], options: Parameters<typeof record>[1]) => {
        expect(options?.schedule).toEqual(RANDOM)
        return record(program, options)
      },
    }

    // Act
    const search = repairSearch(tools, recording, { kind: 'crash' })
    let next = search.next()
    while (next.done !== true) next = search.next()

    // Assert
    expect(recording.outcome.kind).toBe('error')
    expect(next.value.repairs.length).toBeGreaterThan(0)
  })

  test('a sweep forks a run with tasks under its schedule', () => {
    // Arrange
    const source = `var n = 2
let t = spawn(fn(k) { k * n }, 3)
print(wait(t))`
    const recording = recordTasks(source, RANDOM)

    // Act
    let time = 0
    while (recording.locationAt(time)?.stmtLine !== 2) time++
    const result = sweep(recording, time, { kind: 'global', name: 'n' }, [5, 7])

    // Assert
    expect(result.failed).toEqual([])
    expect(result.runs.map((each) => each.recording.outputs[0]?.text)).toEqual(['15', '21'])
  })
})
