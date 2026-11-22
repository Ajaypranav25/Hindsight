import { describe, expect, test } from 'vitest'
import { exploreSchedules, record } from './index'
import { raceCandidates } from './races'
import { BANK_RACE, compileTasks } from './testing/tasks'

describe('exploreSchedules', () => {
  test('finds the lost update of the bank race within 20 schedules and names the balance', () => {
    // Arrange
    const program = compileTasks(BANK_RACE)

    // Act
    const found = exploreSchedules(program, { runs: 20, seed: 1, quantum: 4 })

    // Assert
    expect(found.usesTasks).toBe(true)
    expect(found.groups.length).toBeGreaterThan(1)
    expect(found.groups.reduce((sum, group) => sum + group.seeds.length, 0)).toBe(20)
    const divergence = found.divergence!
    expect(divergence.outputIndex).toBe(0)
    expect(divergence.step).toBeLessThan(divergence.until)
    expect(divergence.diff.same).toBe(false)
    const balance = divergence.candidates.find((candidate) => candidate.name === 'balance')
    expect(balance?.writers.map((writer) => [writer.task, writer.name])).toEqual([
      [2, 'deposit'],
      [3, 'deposit'],
    ])
    expect(balance?.lines).toEqual([6])
  })

  test('a deterministic program falls into one group with no divergence', () => {
    // Arrange
    const program = compileTasks('let ch = channel()\nspawn(fn() { send(ch, 1) })\nprint(recv(ch))')

    // Act
    const found = exploreSchedules(program, { runs: 5 })

    // Assert
    expect(found.groups).toHaveLength(1)
    expect(found.groups[0]!.seeds).toEqual([1, 2, 3, 4, 5])
    expect(found.groups[0]!.outputs).toEqual(['1'])
    expect(found.divergence).toBeNull()
    expect(found.quantum).toBe(10)
  })

  test('a program without tasks says so', () => {
    // Arrange, Act
    const found = exploreSchedules(compileTasks('print(1 + 1)'), { runs: 3, quantum: 0 })

    // Assert
    expect(found.usesTasks).toBe(false)
    expect(found.groups).toHaveLength(1)
    expect(found.quantum).toBe(1)
  })

  test('runs that differ only in outcome compare up to the end', () => {
    // Arrange: one schedule order fails, the other finishes.
    const program = compileTasks(`var log = []
fn add(v) {
  yield()
  push(log, v)
}
let a = spawn(add, 1)
let b = spawn(add, 2)
wait(a)
wait(b)
assert(log[0] == 1)`)

    // Act
    const found = exploreSchedules(program, { runs: 30, quantum: 2 })

    // Assert
    expect(found.groups.map((group) => group.outcome.kind).sort()).toEqual(['error', 'finished'])
    expect(found.divergence?.outputIndex).toBeNull()
    expect(found.divergence?.until).toBe(found.groups[0]!.recording.length)
    expect(found.divergence?.candidates.map((candidate) => candidate.name)).toEqual(['log'])
  })
})

describe('raceCandidates', () => {
  test('a recording without tasks has none', () => {
    // Arrange
    const recording = record(compileTasks('var x = 1\nx = 2'))

    // Act, Assert
    expect(raceCandidates(recording, 0, recording.length)).toEqual([])
  })

  test('fields and captured variables shared by tasks are named', () => {
    // Arrange
    const recording = record(
      compileTasks(`let acct = {total: 0}
fn main() {
  var seen = 0
  let t = spawn(fn() {
    acct.total = acct.total + 1
    seen = seen + 1
  })
  acct.total = acct.total + 10
  seen = seen + 10
  wait(t)
}
main()`),
    )

    // Act
    const names = raceCandidates(recording, 0, recording.length).map((candidate) => candidate.name)

    // Assert
    expect(names.sort()).toEqual(['acct.total', 'seen'])
  })
})
