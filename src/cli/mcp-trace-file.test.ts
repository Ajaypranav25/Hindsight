import { describe, expect, test } from 'vitest'
import { MAX_TRACES, McpServer } from './mcp'

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

const LOOP = 'var total = 0\nfor i in 1..=5 {\n  total += i\n  print(total)\n}\n'

describe('MCP trace files', () => {
  test('a trace exported as a .sighttrace file opens as a verified trace at the saved step', () => {
    // Arrange
    const server = new McpServer('0.4.0')
    const run = call(server, 'run_trace', { source: LOOP }).body

    // Act
    const exported = call(server, 'export_trace', { trace_id: run.trace_id, step: 7 }).body
    const opened = call(server, 'open_trace', { trace_file: exported.trace_file }).body

    // Assert
    expect(exported.bytes).toBeGreaterThan(8)
    expect(exported.fingerprint).toMatch(/^fnv1a64:/)
    expect(Buffer.from(exported.trace_file, 'base64').subarray(0, 8).toString()).toBe('SIGHTTRC')
    expect(opened).toMatchObject({ verified: true, saved_step: 7, what_if_edits: 0 })
    expect(opened.trace_id).not.toBe(run.trace_id)
    expect(opened.output.map((line: { text: string }) => line.text)).toEqual(
      run.output.map((line: { text: string }) => line.text),
    )
  })

  test('a what-if trace keeps its edit chain through a file', () => {
    // Arrange
    const server = new McpServer('0.4.0')
    const run = call(server, 'run_trace', { source: LOOP }).body
    const fork = call(server, 'fork_whatif', {
      trace_id: run.trace_id,
      step: 6,
      name: 'total',
      value: '100',
    })

    // Act
    const forkId = fork.body.trace_id as string
    const exported = call(server, 'export_trace', { trace_id: forkId, title: 'what if' }).body
    const opened = call(server, 'open_trace', { trace_file: exported.trace_file }).body

    // Assert
    expect(fork.isError).toBe(false)
    expect(opened).toMatchObject({ verified: true, what_if_edits: 1, title: 'what if' })
  })

  test('a what-if exports after its real run was dropped, and an opened one saves again', () => {
    // Arrange: a step limit below the default, so the base's limit must survive the round trips.
    const server = new McpServer('0.4.0')
    const run = call(server, 'run_trace', { source: LOOP, max_steps: 5000 }).body
    const fork = call(server, 'fork_whatif', {
      trace_id: run.trace_id,
      step: 6,
      name: 'total',
      value: 100,
    }).body
    for (let i = 0; i < MAX_TRACES - 1; i++) call(server, 'run_trace', { source: `print(${i})` })

    // Act
    const exported = call(server, 'export_trace', { trace_id: fork.trace_id })
    const opened = call(server, 'open_trace', { trace_file: exported.body.trace_file }).body
    const again = call(server, 'export_trace', { trace_id: opened.trace_id }).body

    // Assert
    expect(call(server, 'seek_state', { trace_id: run.trace_id, step: 0 }).isError).toBe(true)
    expect(exported.isError).toBe(false)
    expect(opened).toMatchObject({ verified: true, what_if_edits: 1 })
    expect(again.trace_file).toBe(exported.body.trace_file)
  })

  test('bad input is a tool error, never a protocol error', () => {
    const server = new McpServer('0.4.0')
    expect(call(server, 'open_trace', {}).isError).toBe(true)
    expect(call(server, 'open_trace', { trace_file: '***' }).isError).toBe(true)
    const junk = Buffer.from('not a trace file at all').toString('base64')
    const opened = call(server, 'open_trace', { trace_file: junk })
    expect(opened.isError).toBe(true)
    expect(JSON.stringify(opened.body)).toMatch(/cannot be opened/)
    expect(call(server, 'export_trace', { trace_id: 'missing' }).isError).toBe(true)
  })
})
