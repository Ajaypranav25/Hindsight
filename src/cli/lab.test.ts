import { describe, expect, test } from 'vitest'
import type { CliIO } from './io'
import { main } from './main'
import { McpServer, MAX_TRACES, serveLine } from './mcp'

interface FakeIO extends CliIO {
  readonly out: string[]
  readonly err: string[]
}

function fakeIO(files: Record<string, string>): FakeIO {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    color: false,
    readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
}

const PRICE =
  'let price = 200\nlet discount_rate = 0.2\nlet total = price - price * discount_rate\n' +
  'if total > 500 {\n  print("big spender")\n}\nprint("total: {total}")\n'
const CRASH =
  'fn last(xs) {\n  xs[len(xs) - 0]\n}\nlet items = [4, 5]\nlet spare = 1\nprint(last(items))\n'
const FIB =
  'fn fib(n) { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\nvar best = 0\nbest = fib(6)\nprint(best)\n'

function cli(args: string[], files: Record<string, string>) {
  const io = fakeIO(files)
  const code = main(args, io)
  return { code, out: io.out.join(''), err: io.err.join('') }
}

describe('hindsight solve', () => {
  test('finds earlier values that make the last line print the wanted text', () => {
    const { code, out } = cli(['solve', 'p.sight', '--want', 'total: 100'], { 'p.sight': PRICE })
    expect(code).toBe(0)
    expect(out).toContain('goal: output line 1 to read "total: 100" (it reads "total: 160")')
    expect(out).toMatch(
      /If discount_rate at step \d+ had been 0.5 instead of 0.2, line 7 would have printed total: 100\./,
    )
    expect(out).toMatch(/If price at step \d+ had been 125 instead of 200/)
    expect(out).toMatch(/tried 2 earlier values in \d+ what-if runs/)
  })

  test('--output picks the line; --no-crash avoids the error; failures exit 1', () => {
    const files = { 'p.sight': PRICE, 'c.sight': CRASH, 'f.sight': FIB }
    expect(cli(['solve', 'f.sight', '--want', '13', '--output', '1'], files).out).toContain(
      'instead of 6',
    )
    const avoided = cli(['solve', 'c.sight', '--no-crash'], files)
    expect(avoided.code).toBe(1)
    expect(avoided.out).toContain('goal: the run not to fail')
    const none = cli(['solve', 'p.sight', '--no-crash'], files)
    expect(none.code).toBe(1)
    expect(none.err).toContain('did not fail')
    expect(cli(['solve', 'p.sight', '--want', 'x', '--output', '9'], files).err).toContain(
      'no output line 9',
    )
    expect(cli(['solve', 'p.sight'], files).code).toBe(2)
    expect(cli(['solve', 'p.sight', '--want', 'x', '--no-crash'], files).code).toBe(2)
  })
})

describe('hindsight query', () => {
  const files = { 'f.sight': FIB }
  test('prints stretches, changes and calls', () => {
    expect(cli(['query', 'f.sight', 'when depth > 5'], files).out).toMatch(
      /^\d+ stretch(es)? \(\d+ statements\)\n {2}step /,
    )
    const changed = cli(['query', 'f.sight', 'changed(best)'], files)
    expect(changed.out).toContain('2 changes')
    expect(changed.out).toMatch(/best = 8 {2}line 3/)
    const calls = cli(['query', 'f.sight', 'calls(fib) where n >= 5'], files)
    expect(calls.out).toContain('2 calls')
    expect(calls.out).toContain('fib(n = 6) returned 8')
  })

  test('--limit truncates with a note; bad queries are errors', () => {
    const limited = cli(['query', 'f.sight', 'calls(fib)', '--limit', '2'], files)
    expect(limited.out).toContain('25 calls')
    expect(limited.out).toContain('more not shown (raise --limit)')
    const bad = cli(['query', 'f.sight', 'when print(1)'], files)
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('Queries can call only')
    expect(cli(['query', 'f.sight'], files).code).toBe(2)
    expect(cli(['query', 'f.sight', 'x', '--limit', '0'], files).code).toBe(2)
  })
})

describe('hindsight whynot, slice and repair', () => {
  test('whynot explains a guard with its line and a replay hint', () => {
    const { code, out } = cli(['whynot', 'p.sight', '--line', '5'], { 'p.sight': PRICE })
    expect(code).toBe(0)
    expect(out).toMatch(
      /^Line 5 never ran because at step \d+, `total > 500` was false \(total was 160/,
    )
    expect(out).toContain('   4 | if total > 500 {')
    expect(out).toMatch(/replay it: hindsight replay p.sight --at \d+/)
    expect(cli(['whynot', 'p.sight', '--line', '7'], { 'p.sight': PRICE }).out).toBe(
      'Line 7 did run (once).\n',
    )
    expect(cli(['whynot', 'p.sight', '--line', '6'], { 'p.sight': PRICE }).out).toContain('no code')
    expect(cli(['whynot', 'p.sight'], { 'p.sight': PRICE }).code).toBe(2)
  })

  test('slice marks the lines that led to the crash, the last output, or a step', () => {
    const crash = cli(['slice', 'c.sight'], { 'c.sight': CRASH })
    expect(crash.out).toContain('led to the runtime error')
    expect(crash.out).toContain('>   4 | let items = [4, 5]')
    expect(crash.out).toContain('    5 | let spare = 1')
    const normal = cli(['slice', 'p.sight'], { 'p.sight': PRICE })
    expect(normal.out).toContain('led to the last output line ("total: 160")')
    expect(normal.out).toContain('    4 | if total > 500 {')
    expect(normal.out.endsWith('print("total: {total}")\n')).toBe(true)
    expect(cli(['slice', 'p.sight', '--at', '3'], { 'p.sight': PRICE }).out).toContain('step 3')
    expect(cli(['slice', 'p.sight', '--at', '9999'], { 'p.sight': PRICE }).code).toBe(1)
    expect(cli(['slice', 'e.sight'], { 'e.sight': 'let a = 1\n' }).err).toContain('printed nothing')
  })

  test('repair previews one-token fixes for a crash', () => {
    const { code, out } = cli(['repair', 'c.sight'], { 'c.sight': CRASH })
    expect(code).toBe(0)
    expect(out).toContain('✓ line 2: `0` → `1`')
    expect(out).toContain('    - xs[len(xs) - 0]')
    expect(out).toContain('    + xs[len(xs) - 1]')
    const fine = cli(['repair', 'p.sight'], { 'p.sight': PRICE })
    expect(fine.code).toBe(1)
    expect(fine.err).toContain('did not crash')
    const stuck = cli(['repair', 'n.sight'], {
      'n.sight': 'fn f(x) {\n  x\n}\nprint(f(nil) + 1)\n',
    })
    expect(stuck.code).toBe(1)
  })

  test('program text is sanitized on its way to the terminal', () => {
    const source = 'let v = "a\\u{1b}[31mb"\nif v == "x" {\n  print(1)\n}\nprint(v)\n'
    const files = { 's.sight': source }
    for (const args of [
      ['whynot', 's.sight', '--line', '3'],
      ['query', 's.sight', 'changed(v)'],
    ]) {
      const { out } = cli(args, files)
      expect(out).not.toContain('\u001b')
    }
  })
})

describe('whatif sweeps and debug by halving', () => {
  test('a range prints one row per value and the longest run', () => {
    const source =
      'fn steps(n) {\n  var c = 0\n  var x = n\n  while x != 1 {\n    x = if x % 2 == 0 { x / 2 } else { 3 * x + 1 }\n    c += 1\n  }\n  c\n}\nlet start = 6\nprint(steps(start))\n'
    const { code, out } = cli(['whatif', 's.sight', '--at', '6', '--set', 'start=6..8'], {
      's.sight': source,
    })
    expect(code).toBe(0)
    expect(out).toContain('what if start = 3 values at step 6')
    expect(out.split('\n').filter((line) => /^ {2}\d/.test(line))).toHaveLength(3)
    expect(out).toContain('longest: start = 7')
    expect(
      cli(['whatif', 's.sight', '--at', '6', '--set', 'start=1..999'], { 's.sight': source }).code,
    ).toBe(2)
  })

  test('debug defaults to divide and query and accepts --strategy', () => {
    const io = fakeIO({})
    expect(main(['debug', 'a.sight', '--strategy', 'sideways'], io)).toBe(2)
    expect(io.err.join('')).toContain("--strategy must be 'divide' or 'top-down'")
  })
})

describe('hindsight mcp', () => {
  const call = (server: McpServer, name: string, args: object, id = 1) => {
    const reply = server.handle({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }) as {
      result: { content: { text: string }[]; isError: boolean }
    }
    return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
  }

  test('speaks JSON-RPC: initialize, ping, tools/list, notifications, unknown methods', () => {
    const server = new McpServer('9.9.9')
    expect(
      server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    ).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'hindsight', version: '9.9.9' }, capabilities: { tools: {} } },
    })
    expect(server.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {},
    })
    const list = server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as {
      result: { tools: { name: string; description: string; inputSchema: { type: string } }[] }
    }
    expect(list.result.tools.map((tool) => tool.name)).toEqual([
      'run_trace',
      'seek_state',
      'query_provenance',
      'fork_whatif',
      'get_divergence',
      'query',
      'why_not',
      'slice',
      'solve',
    ])
    for (const tool of list.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
    }
    expect(server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(server.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).toMatchObject({
      error: { code: -32601 },
    })
    expect(server.handle('junk')).toMatchObject({ error: { code: -32600 } })
    expect(server.handle({ id: 5 })).toMatchObject({ error: { code: -32600 } })
  })

  test('runs a trace, looks at a state, asks where a value came from', () => {
    const server = new McpServer('0')
    const run = call(server, 'run_trace', { source: PRICE })
    expect(run.body).toMatchObject({ trace_id: 't1', outcome: { kind: 'finished' } })
    expect(run.body.output).toEqual([{ step: expect.any(Number), text: 'total: 160' }])
    const state = call(server, 'seek_state', { trace_id: 't1', step: run.body.steps - 2 })
    expect(state.body.globals).toMatchObject({ price: 200, total: 160 })
    const origin = call(server, 'query_provenance', {
      trace_id: 't1',
      step: run.body.steps - 2,
      name: 'total',
    })
    expect(origin.body).toMatchObject({
      value: 160,
      origin: { line: 3, name: 'total', value: 160 },
    })
    expect(call(server, 'why_not', { trace_id: 't1', line: 5 }).body.kind).toBe('guard')
    expect(call(server, 'slice', { trace_id: 't1' }).body.lines_ruled_out).toEqual([4])
    expect(call(server, 'query', { trace_id: 't1', query: 'changed(total)' }).body.total).toBe(1)
    const solved = call(server, 'solve', { trace_id: 't1', want: 'total: 100' })
    expect(solved.body.solutions[0]).toMatchObject({ name: 'discount_rate', value: 0.5 })
  })

  test('forks a what-if and reports the divergence with the heap difference', () => {
    const server = new McpServer('0')
    const source = 'let tail = {v: 2}\nvar head = {v: 1, next: tail}\nlet n = 3\nprint(n)\n'
    const run = call(server, 'run_trace', { source })
    const step = run.body.steps - 4
    const fork = call(server, 'fork_whatif', { trace_id: 't1', step, name: 'head', value: 7 })
    expect(fork.body).toMatchObject({ trace_id: 't2', forked_from: 't1', output_lines_added: 0 })
    const divergence = call(server, 'get_divergence', { trace_id: 't2' })
    expect(divergence.body.divergence_step).toBe(fork.body.divergence_step)
    expect(call(server, 'get_divergence', { trace_id: 't1' }).isError).toBe(true)
  })

  test('bad calls are tool errors, never exceptions', () => {
    const server = new McpServer('0')
    expect(call(server, 'run_trace', { source: 'let = 1' }).body).toMatchObject({ compiled: false })
    for (const [name, args] of [
      ['nope', {}],
      ['run_trace', {}],
      ['run_trace', { source: 'print(1)', max_steps: -1 }],
      ['seek_state', { trace_id: 't9', step: 0 }],
      ['fork_whatif', { trace_id: 't1', step: 0, name: 'x', value: 1 }],
    ] as const) {
      expect(call(server, name, args).isError).toBe(true)
    }
    call(server, 'run_trace', { source: 'let a = 1\nprint(a)\n' })
    expect(call(server, 'seek_state', { trace_id: 't1', step: 1e9 }).isError).toBe(true)
    expect(call(server, 'seek_state', { trace_id: 't1', step: 0.5 }).isError).toBe(true)
    expect(
      call(server, 'query_provenance', { trace_id: 't1', step: 0, name: '__proto__' }).isError,
    ).toBe(true)
    expect(
      call(server, 'fork_whatif', { trace_id: 't1', step: 1, name: 'a', value: [1] }).isError,
    ).toBe(true)
    expect(call(server, 'query', { trace_id: 't1', query: 'when (' }).isError).toBe(true)
    expect(call(server, 'solve', { trace_id: 't1' }).isError).toBe(true)
  })

  test('old traces are dropped; serveLine writes one line per reply', () => {
    const server = new McpServer('0')
    for (let i = 0; i <= MAX_TRACES; i++) call(server, 'run_trace', { source: 'print(1)\n' })
    expect(call(server, 'seek_state', { trace_id: 't1', step: 0 }).isError).toBe(true)
    expect(call(server, 'seek_state', { trace_id: 't2', step: 0 }).isError).toBe(false)
    const written: string[] = []
    serveLine(server, '{bad', (text) => written.push(text))
    serveLine(server, '', (text) => written.push(text))
    serveLine(server, '{"jsonrpc":"2.0","id":1,"method":"ping"}', (text) => written.push(text))
    serveLine(server, '{"jsonrpc":"2.0","method":"notifications/initialized"}', (text) =>
      written.push(text),
    )
    expect(written).toHaveLength(2)
    expect(JSON.parse(written[0]!)).toMatchObject({ error: { code: -32700 } })
    expect(written[1]).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n')
  })
})
