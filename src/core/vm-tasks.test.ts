import { describe, expect, test } from 'vitest'
import type { ScheduleOptions } from './api-types'
import { run } from './index'
import type { Value } from './runtime-types'
import { BANK_RACE, PIPELINE, compileTasks, tasksVM } from './testing/tasks'
import { digest } from './testing/vm-digest'
import { type HookEvent, recordingHooks } from './testing/vm-harness'

const RANDOM: ScheduleOptions = { policy: 'random', quantum: 4, seed: 7 }

function outputOf(source: string, schedule?: ScheduleOptions): string[] {
  const result = run(compileTasks(source), { schedule })
  if (result.outcome.kind === 'error') throw new Error(result.outcome.error.message)
  return result.outputs.map((event) => event.text)
}

describe('programs without tasks', () => {
  test('a program that never spawns keeps no task records', () => {
    // Arrange
    const vm = tasksVM(compileTasks('var s = 0\nfor i in 0..5 { s = s + i }\nprint(s)'))

    // Act
    vm.runUntil(1000)

    // Assert
    expect(vm.status).toBe('finished')
    expect(vm.tasks).toBeNull()
    expect(vm.taskId).toBe(1)
  })

  test('the random policy changes nothing while there is a single task', () => {
    // Arrange
    const program = compileTasks('print(random(), random_int(1, 6))\nyield()\nprint(steps())')

    // Act
    const plain = run(program)
    const randomized = run(program, { schedule: RANDOM })

    // Assert
    expect(randomized).toEqual(plain)
  })
})

describe('scheduling', () => {
  test('round-robin runs every task to its end without lost updates', () => {
    // Arrange, Act
    const output = outputOf(BANK_RACE)

    // Assert
    expect(output).toEqual(['60'])
  })

  test('a random schedule is reproduced exactly by its seed', () => {
    // Arrange
    const program = compileTasks(BANK_RACE)

    // Act
    const first = run(program, { schedule: RANDOM })
    const second = run(program, { schedule: RANDOM })

    // Assert
    expect(second).toEqual(first)
  })

  test('different schedule seeds interleave differently and can lose updates', () => {
    // Arrange
    const program = compileTasks(BANK_RACE)

    // Act
    const balances = new Set<string>()
    for (let seed = 1; seed <= 20; seed++) {
      const result = run(program, { schedule: { policy: 'random', quantum: 4, seed } })
      balances.add(result.outputs[0]!.text)
    }

    // Assert
    expect(balances.size).toBeGreaterThan(1)
    expect([...balances].some((balance) => Number(balance) < 60)).toBe(true)
  })

  test('the scheduler draws from its own generator, not the program one', () => {
    // Arrange: only main draws, after spawning a task that never draws.
    const source = `
      spawn(fn() { for i in 0..20 { yield() } })
      var draws = []
      for i in 0..5 { push(draws, random_int(0, 99)); yield() }
      print(draws)
    `

    // Act
    const roundRobin = outputOf(source)
    const randomized = outputOf(source, { policy: 'random', quantum: 2, seed: 99 })

    // Assert
    expect(randomized).toEqual(roundRobin)
  })

  test('a task runs at most quantum instructions before it is preempted', () => {
    // Arrange: two tasks that never block, so only preemption switches between them.
    const program = compileTasks(`
      fn spin() { var i = 0
        while true { i = i + 1 } }
      spawn(spin)
      spawn(spin)
      yield()
      while true {}
    `)
    const vm = tasksVM(program, { policy: 'random', quantum: 3, seed: 5 })
    vm.runUntil(40)

    // Act
    const owners: number[] = []
    for (let t = 0; t < 400; t++) {
      owners.push(vm.taskId)
      vm.step()
    }

    // Assert
    let longest = 0
    let current = 0
    for (let i = 0; i < owners.length; i++) {
      current = i > 0 && owners[i] === owners[i - 1] ? current + 1 : 1
      longest = Math.max(longest, current)
    }
    expect(longest).toBeLessThanOrEqual(3)
    expect(new Set(owners).size).toBe(3)
  })
})

describe('time', () => {
  test.each([
    ['round-robin', undefined],
    ['random', RANDOM],
  ] as const)(
    'stepping one instruction at a time reaches the states running does (%s)',
    (_name, schedule) => {
      // Arrange
      const program = compileTasks(PIPELINE)
      const stepped = tasksVM(program, schedule)
      const fresh = tasksVM(program, schedule)
      fresh.runUntil(Infinity)
      const length = fresh.time

      // Act, Assert: every 7th time, a VM run straight to it matches the stepping one.
      for (let t = 0; t < length; t++) {
        if (t % 7 === 0) {
          const direct = tasksVM(program, schedule)
          direct.runUntil(t)
          expect(digest(direct)).toBe(digest(stepped))
        }
        stepped.step()
      }
      expect(stepped.status).toBe('finished')
    },
  )

  test('a snapshot restores every task, channel and the scheduler state', () => {
    // Arrange
    const program = compileTasks(PIPELINE)
    const reference = tasksVM(program, RANDOM)
    reference.runUntil(Infinity)
    const end = digest(reference)
    const length = reference.time

    for (let t = 0; t < length; t += 11) {
      const source = tasksVM(program, RANDOM)
      source.runUntil(t)
      const snapshot = source.snapshot()
      const restored = tasksVM(program, RANDOM)

      // Act
      restored.restore(snapshot)

      // Assert: same state now and the same run to the end.
      expect(digest(restored)).toBe(digest(source))
      restored.runUntil(Infinity)
      expect(digest(restored)).toBe(end)
    }
  })

  test('restoring again after running on rebuilds the earlier state (delta restore)', () => {
    // Arrange
    const program = compileTasks(PIPELINE)
    const vm = tasksVM(program, RANDOM)
    vm.runUntil(120)
    const snapshot = vm.snapshot()
    const at120 = digest(vm)
    const other = tasksVM(program, RANDOM)
    other.restore(snapshot)

    // Act: run on past several switches, then restore the same snapshot.
    other.runUntil(260)
    other.restore(snapshot)

    // Assert
    expect(digest(other)).toBe(at120)
  })

  test('hooks observe without changing any task state', () => {
    // Arrange
    const program = compileTasks(PIPELINE)
    const hooked = tasksVM(program, RANDOM)
    const events: HookEvent[] = []
    hooked.hooks = recordingHooks(events)
    const plain = tasksVM(program, RANDOM)

    // Act
    hooked.runUntil(Infinity)
    plain.runUntil(Infinity)

    // Assert
    expect(digest(hooked)).toBe(digest(plain))
    expect(events.some((event) => event.e === 'alloc' && event.type === 'task')).toBe(true)
    expect(events.some((event) => event.e === 'alloc' && event.type === 'channel')).toBe(true)
  })
})

describe('blocking', () => {
  test('a blocked call keeps its callee and arguments until a sender completes it', () => {
    // Arrange
    const program = compileTasks(`
      let ch = channel()
      spawn(fn() { send(ch, "hi") })
      let got = recv(ch)
      print(got)
    `)
    const vm = tasksVM(program)
    while (vm.tasks === null || vm.tasks[0]!.status !== 'blocked') vm.step()

    // Act
    const main = vm.tasks[0]!
    const top = main.stack.slice(-2)

    // Assert
    expect(vm.taskId).toBe(2)
    expect(main.wait).toMatchObject({ kind: 'recv' })
    expect((top[0] as { name: string }).name).toBe('recv')
    expect((top[1] as { type: string }).type).toBe('channel')
    vm.runUntil(Infinity)
    expect(vm.status).toBe('finished')
    expect(vm.tasks[0]!.status).toBe('done')
  })

  test('a deadlock reports in the task that blocked last, with its stack', () => {
    // Arrange
    const program = compileTasks(`
      let a = channel()
      fn left() { recv(a) }
      spawn(left)
      wait(current_task() == nil)
    `)

    // Act
    const result = run(program)

    // Assert: wait(false) is an argument error, not a deadlock.
    expect(result.outcome.kind).toBe('error')
    const deadlock = run(
      compileTasks(`
        let a = channel()
        fn left() { recv(a) }
        let t = spawn(left)
        wait(t)
      `),
    )
    if (deadlock.outcome.kind !== 'error') throw new Error('expected an error')
    expect(deadlock.outcome.error.code).toBe('R028')
    expect(deadlock.outcome.error.stack.map((entry) => entry.name)).toEqual(['left'])
    expect(deadlock.outcome.error.hint).toBe(
      'task 2 (left) waits to receive from channel #2 here; task 1 (main) waits for task 2 (left) on line 5',
    )
  })

  test('tasks left unfinished by the main task are reported in the outcome', () => {
    // Arrange
    const program = compileTasks(`
      let never = channel()
      spawn(fn() { recv(never) })
      spawn(fn() { while true { yield() } })
      yield()
    `)

    // Act
    const result = run(program)

    // Assert
    expect(result.outcome).toEqual({
      kind: 'finished',
      unfinishedTasks: [
        { id: 2, name: 'lambda', status: 'blocked', wait: { kind: 'recv', channelId: 2 } },
        { id: 3, name: 'lambda', status: 'runnable', wait: null },
      ],
    })
  })
})

describe('limits', () => {
  test('the call depth limit applies to each task on its own', () => {
    // Arrange
    const program = compileTasks(`
      fn down(n) { if n == 0 { 0 } else { 1 + down(n - 1) } }
      fn deep() { return down(9000) }
      let a = spawn(deep)
      print(down(5000), wait(a))
      spawn(fn() { down(20000) })
      yield()
    `)

    // Act
    const result = run(program)

    // Assert
    expect(result.outputs.map((event) => event.text)).toEqual(['5000 9000'])
    if (result.outcome.kind !== 'error') throw new Error('expected an error')
    expect(result.outcome.error.code).toBe('R016')
  })

  test('at most 10,000 tasks may be unfinished', () => {
    // Arrange
    const program = compileTasks('while true { spawn(fn() { yield() }) }')

    // Act
    const result = run(program, { maxSteps: 1_000_000 })

    // Assert
    if (result.outcome.kind !== 'error') throw new Error('expected an error')
    expect(result.outcome.error.code).toBe('R030')
    expect(result.outcome.error.message).toBe('too many tasks: more than 10000 are unfinished')
  })

  test('finished tasks free their place under the limit', () => {
    // Arrange
    const program = compileTasks(`
      var done = 0
      for i in 0..10005 { wait(spawn(fn() { done = done + 1 })) }
      print(done)
    `)

    // Act
    const result = run(program, { maxSteps: 2_000_000 })

    // Assert
    expect(result.outputs.map((event) => event.text)).toEqual(['10005'])
  })
})

describe('values', () => {
  test('tasks and channels compare by identity', () => {
    // Arrange, Act
    const output = outputOf(`
      let a = channel()
      let t = spawn(fn() { 1 })
      print(a == a, a == channel(), t == t, [t] == [t], type(t), type(a))
    `)

    // Assert
    expect(output).toEqual(['true false true true task channel'])
  })

  test('a channel buffer copied into a snapshot keeps its values', () => {
    // Arrange
    const program = compileTasks('let ch = channel(3)\nsend(ch, [1])\nsend(ch, "x")\nprint(1)')
    const vm = tasksVM(program)
    vm.runUntil(Infinity)

    // Act
    const restored = tasksVM(program)
    restored.restore(vm.snapshot())
    const channel = restored.globals.get('ch') as Value

    // Assert
    expect(channel).toMatchObject({ type: 'channel', capacity: 3, closed: false })
    expect(digest(restored)).toContain('channel 3')
  })
})
