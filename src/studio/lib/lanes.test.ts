import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { TaskSwitch } from '../../core/api-types'
import { compile, record } from '../../core/index'
import { buildLaneModel, laneAt, laneEnvelope, laneRange, MAX_LANES, type LaneModel } from './lanes'
import { NO_DATA } from './timeline-math'

function model(depths: number[], tasks: number[], switches: TaskSwitch[] = []): LaneModel {
  const names = new Map([...new Set(tasks)].map((id) => [id, id === 1 ? 'main' : `t${id}`]))
  return buildLaneModel({
    depths: Int32Array.from(depths),
    tasks: Int32Array.from(tasks),
    switches,
    names,
  })
}

/** The lane's min and max depth over `[from, to)` by looking at every step. */
function bruteRange(m: LaneModel, lane: number, from: number, to: number) {
  let min = Infinity
  let max = -1
  for (let t = Math.max(0, from); t < Math.min(m.length, to); t++) {
    if (m.laneOf[m.tasks[t]!] !== lane) continue
    min = Math.min(min, m.depths[t]!)
    max = Math.max(max, m.depths[t]!)
  }
  return max < 0 ? null : { min, max }
}

describe('buildLaneModel', () => {
  test('one lane per task in id order, labelled with the task’s number and name', () => {
    // Arrange, Act
    const m = model([0, 0, 1, 0, 2, 0], [1, 2, 2, 1, 3, 3])

    // Assert
    expect(m.lanes.map((lane) => [lane.label, lane.maxDepth])).toEqual([
      ['1 main', 0],
      ['2 t2', 1],
      ['3 t3', 2],
    ])
    expect(laneAt(m, 4)).toEqual({ lane: 2, depth: 2 })
    expect(laneAt(m, 99)).toEqual({ lane: 2, depth: 0 })
  })

  test('tasks beyond the lane limit share the last lane', () => {
    // Arrange
    const tasks = Array.from({ length: 12 }, (_, i) => i + 1)

    // Act
    const m = model(Array(12).fill(0), tasks)

    // Assert
    expect(m.lanes).toHaveLength(MAX_LANES)
    expect(m.lanes.at(-1)).toMatchObject({ label: '+5 more', tasks: [8, 9, 10, 11, 12] })
    expect(m.laneOf[12]).toBe(MAX_LANES - 1)
  })

  test('waiting stretches run from the switch away until the switch back, or the end', () => {
    // Arrange
    const switches: TaskSwitch[] = [
      { time: 2, from: 1, to: 2, state: 'blocked' },
      { time: 5, from: 2, to: 1, state: 'blocked' },
      { time: 7, from: 1, to: 2, state: 'runnable' },
    ]

    // Act
    const m = model([0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 2, 2, 2, 1, 1, 2, 2], switches)

    // Assert
    expect([...m.lanes[0]!.waits]).toEqual([2, 5])
    expect([...m.lanes[1]!.waits]).toEqual([5, 7])
  })

  test('a task still waiting at the end waits until the end', () => {
    // Arrange, Act
    const m = model([0, 0, 0], [1, 2, 2], [{ time: 1, from: 1, to: 2, state: 'blocked' }])

    // Assert
    expect([...m.lanes[0]!.waits]).toEqual([1, 3])
  })
})

describe('laneRange', () => {
  test('agrees with a scan of every step, at every offset and block boundary', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 1, max: 3 })), {
          minLength: 1,
          maxLength: 120,
        }),
        fc.nat(),
        fc.nat(),
        (steps, a, b) => {
          const m = model(
            steps.map(([depth]) => depth),
            steps.map(([, task]) => task),
          )
          const from = a % (steps.length + 1)
          const to = from + (b % (steps.length + 2))
          for (let lane = 0; lane < m.lanes.length; lane++) {
            expect(laneRange(m, lane, from, to)).toEqual(bruteRange(m, lane, from, to))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  test('columns without a step of the lane hold no data', () => {
    // Arrange
    const m = model([0, 1, 2, 3], [1, 1, 2, 2])

    // Act
    const columns = laneEnvelope(m, 0, 0, 4, 4)

    // Assert
    expect([...columns.max]).toEqual([0, 1, NO_DATA, NO_DATA])
    expect([...laneEnvelope(m, 0, 0, 4, 0).max]).toEqual([])
    expect([...laneEnvelope(m, 0, 4, 4, 2).max]).toEqual([NO_DATA, NO_DATA])
  })
})

describe('lanes from a real recording', () => {
  test('a producer and a consumer get a lane each and the consumer’s waits', () => {
    // Arrange
    const compiled = compile(
      'let ch = channel()\nfn producer() {\n  for i in 0..3 { send(ch, i) }\n}\nspawn(producer)\nfor i in 0..3 { print(recv(ch)) }',
    )
    if (!compiled.ok) throw new Error('does not compile')
    const recording = record(compiled.program)

    // Act
    const m = buildLaneModel({
      depths: recording.depthSeries(),
      tasks: recording.taskSeries()!,
      switches: recording.taskSwitches(),
      names: new Map([
        [1, 'main'],
        [2, 'producer'],
      ]),
    })

    // Assert
    expect(m.lanes.map((lane) => lane.label)).toEqual(['1 main', '2 producer'])
    expect(m.lanes[0]!.waits.length).toBeGreaterThan(0)
    expect(m.lanes[1]!.waits.length).toBeGreaterThan(0)
  })
})
