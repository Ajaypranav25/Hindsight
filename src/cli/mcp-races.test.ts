import { describe, expect, test } from 'vitest'
import { BANK_RACE } from '../core/testing/tasks'
import { McpServer } from './mcp'

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

const STUCK = `let ch = channel()
fn worker() {
  print(recv(ch))
}
spawn(worker)
yield()
print("main done")`

describe('MCP tools for tasks', () => {
  test('explore_schedules finds the bank race and keeps one trace per result', () => {
    // Arrange
    const server = new McpServer('0.4.0')

    // Act
    const { isError, body } = call(server, 'explore_schedules', {
      source: BANK_RACE,
      runs: 12,
      quantum: 4,
    })

    // Assert
    expect(isError).toBe(false)
    expect(body).toMatchObject({ runs: 12, quantum: 4, uses_tasks: true })
    expect(body.results).toBeGreaterThan(1)
    expect(body.groups[0].trace_id).toMatch(/^t\d+$/)
    expect(body.divergence.trace_a).toBe(body.groups[0].trace_id)
    expect(body.divergence.race_candidates[0]).toEqual({
      name: 'balance',
      writers: [
        { task: 2, name: 'deposit', writes: 30 },
        { task: 3, name: 'deposit', writes: 30 },
      ],
      lines: [6],
    })
    expect(body.divergence.origins[0].function).toBe('deposit')
    const seek = call(server, 'seek_state', { trace_id: body.groups[1].trace_id, step: 30 })
    expect(seek.body.tasks.map((task: { name: string }) => task.name)).toEqual([
      'main',
      'deposit',
      'deposit',
    ])
  })

  test('explore_schedules works from a trace and says when there are no tasks', () => {
    // Arrange
    const server = new McpServer('0.4.0')
    const run = call(server, 'run_trace', { source: 'print(2)' }).body

    // Act
    const { body } = call(server, 'explore_schedules', { trace_id: run.trace_id, runs: 2 })

    // Assert
    expect(body).toMatchObject({ uses_tasks: false, results: 1, divergence: null })
    expect(body.note).toMatch(/never started a task/)
  })

  test('run_trace takes a schedule and reports unfinished tasks', () => {
    // Arrange
    const server = new McpServer('0.4.0')

    // Act
    const random = call(server, 'run_trace', {
      source: BANK_RACE,
      schedule: { policy: 'random', seed: 3, quantum: 4 },
    }).body
    const again = call(server, 'run_trace', {
      source: BANK_RACE,
      schedule: { policy: 'random', seed: 3, quantum: 4 },
    }).body
    const stuck = call(server, 'run_trace', { source: STUCK }).body

    // Assert
    expect(random.output).toEqual(again.output)
    expect(stuck.outcome).toEqual({
      kind: 'finished',
      unfinished_tasks: [
        {
          task: 2,
          name: 'worker',
          status: 'blocked',
          wait: { waits_for: 'recv', channel: expect.any(Number) },
        },
      ],
    })
  })

  test('a bad schedule is a tool error', () => {
    // Arrange
    const server = new McpServer('0.4.0')

    // Act, Assert
    expect(call(server, 'run_trace', { source: 'print(1)', schedule: 'random' }).isError).toBe(true)
    expect(
      call(server, 'run_trace', { source: 'print(1)', schedule: { policy: 'fair' } }).isError,
    ).toBe(true)
    expect(
      call(server, 'run_trace', { source: 'print(1)', schedule: { policy: 'random', quantum: 0 } })
        .isError,
    ).toBe(true)
    expect(
      call(server, 'run_trace', { source: 'print(1)', schedule: { policy: 'round-robin' } })
        .isError,
    ).toBe(false)
  })
})
