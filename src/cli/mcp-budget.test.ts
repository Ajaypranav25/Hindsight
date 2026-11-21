import { describe, expect, test } from 'vitest'
import { McpServer } from './mcp'
import { guardResponse, MAX_RESPONSE_CHARS } from './mcp-guard'
import type { Json } from './mcp-shared'
import { jsonLiteral } from './mcp-shared'

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'b',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  const text = reply.result.content[0]!.text
  return { isError: reply.result.isError, body: JSON.parse(text), length: text.length }
}

const LOOP = 'var total = 0\nfor i in 1..=1000 {\n  total += i\n}\nprint(total)\n'
const CHATTY = 'for i in 0..250 {\n  print("line {i}")\n}\n'
const NESTED =
  'let grid = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]\nlet who = {name: "ada", tags: ["x", "y"]}\n' +
  'fn down(n) {\n  if n == 0 { 0 } else { down(n - 1) }\n}\ndown(3)\n'

describe('query budgets', () => {
  test('pages of matches with offset, limit and how to fetch more', () => {
    const server = new McpServer('0')
    call(server, 'run_trace', { source: LOOP })
    const first = call(server, 'query', { trace_id: 't1', query: 'changed(total)', limit: 10 })
    expect(first.body).toMatchObject({
      kind: 'changed',
      total: 1001,
      offset: 0,
      limit: 10,
      truncated: true,
      next_offset: 10,
    })
    expect(first.body.events).toHaveLength(10)
    expect(first.body.more).toContain('offset: 10')
    const last = call(server, 'query', {
      trace_id: 't1',
      query: 'changed(total)',
      offset: 1000,
      limit: 10,
    })
    expect(last.body).toMatchObject({ truncated: false, next_offset: null, more: null })
    expect(last.body.events).toHaveLength(1)
    const defaults = call(server, 'query', { trace_id: 't1', query: 'changed(total)' })
    expect(defaults.body.events).toHaveLength(50)
    const capped = call(server, 'query', { trace_id: 't1', query: 'changed(total)', limit: 9999 })
    expect(capped.body.events).toHaveLength(500)
    const calls = call(server, 'query', { trace_id: 't1', query: 'when total > 499000' })
    expect(calls.body).toMatchObject({ kind: 'when', truncated: false })
    expect(
      call(server, 'query', { trace_id: 't1', query: 'changed(total)', offset: -1 }).isError,
    ).toBe(true)
    expect(
      call(server, 'query', { trace_id: 't1', query: 'changed(total)', summary: 'yes' }).isError,
    ).toBe(true)
  })

  test('summary: groups by line and collapses a loop into one row', () => {
    const server = new McpServer('0')
    call(server, 'run_trace', { source: LOOP })
    const { body } = call(server, 'query', {
      trace_id: 't1',
      query: 'changed(total)',
      summary: true,
    })
    expect(body).toMatchObject({ summary: true, matches: 1001, rows_total: 2, groups_total: 2 })
    expect(body.rows[1]).toMatchObject({
      line: 3,
      count: 1000,
      name: 'total',
      min: 1,
      max: 500500,
    })
    expect(body.rows[1].text).toMatch(
      /^total: line 3 ×1,000, steps [\d,]+–[\d,]+, values 1–500500$/,
    )
    expect(body.rows[0].text).toMatch(/^total: line 1, step \d+, value 0$/)
  })

  test('summaries of calls and of when-intervals', () => {
    const server = new McpServer('0')
    const source =
      'fn sq(n) { n * n }\nvar t = 0\nfor i in 1..=20 {\n  t += sq(i)\n}\nprint(sq(3))\n'
    call(server, 'run_trace', { source })
    const calls = call(server, 'query', { trace_id: 't1', query: 'calls(sq)', summary: true })
    expect(calls.body.rows[0]).toMatchObject({ line: 4, count: 20, min: 1, max: 400 })
    expect(calls.body.rows[1]).toMatchObject({ line: 6, count: 1, min: 9 })
    const when = call(server, 'query', {
      trace_id: 't1',
      query: 'when t > 100',
      summary: true,
      limit: 1,
    })
    expect(when.body).toMatchObject({ kind: 'when', summary: true, limit: 1 })
    expect(when.body.rows).toHaveLength(1)
    expect(when.body.statements_matched).toBeGreaterThan(0)
  })
})

describe('seek_state budgets', () => {
  const deepest = (server: McpServer): number => {
    const found = call(server, 'query', { trace_id: 't1', query: 'when n == 0', limit: 1 })
    return found.body.intervals[0].from as number
  }

  test('frames, globals, nesting depth and items are the agent’s to choose', () => {
    const server = new McpServer('0')
    call(server, 'run_trace', { source: NESTED })
    const step = deepest(server)
    const all = call(server, 'seek_state', { trace_id: 't1', step }).body
    expect(all.frames_total).toBe(5)
    expect(all.frames).toHaveLength(5)
    expect(all.globals.grid).toMatchObject({ type: 'list', length: 3 })
    expect(all.globals.grid.items[0]).toEqual({
      object: expect.any(Number),
      type: 'list',
      preview: '[1, 2, 3]',
    })
    expect(all.notes).toBeUndefined()
    const top = call(server, 'seek_state', { trace_id: 't1', step, frames: 'top' }).body
    expect(top.frames).toHaveLength(1)
    expect(top.frames[0]).toMatchObject({ function: 'down', locals: { n: 0 } })
    expect(top.notes[0]).toContain('showing 1 of 5 frames')
    const two = call(server, 'seek_state', { trace_id: 't1', step, frames: 2 }).body
    expect(two.frames).toHaveLength(2)
    const bare = call(server, 'seek_state', { trace_id: 't1', step, include_globals: false }).body
    expect(bare.globals).toBeUndefined()
    const deep = call(server, 'seek_state', {
      trace_id: 't1',
      step,
      max_depth: 2,
      max_items: 2,
      frames: 'top',
    }).body
    expect(deep.globals.grid).toMatchObject({ length: 3, more: 1, items: [{ items: [1, 2] }, {}] })
    expect(deep.globals.who.entries.tags).toMatchObject({ items: ['x', 'y'] })
    expect(deep.notes.join(' ')).toContain('at most 2 items')
    const flat = call(server, 'seek_state', { trace_id: 't1', step, max_depth: 0 }).body
    expect(flat.globals.grid).toEqual({
      object: expect.any(Number),
      type: 'list',
      preview: expect.any(String),
    })
    for (const bad of [
      { max_depth: 99 },
      { max_items: 0 },
      { frames: 'some' },
      { frames: 0 },
      { include_globals: 'no' },
    ]) {
      expect(call(server, 'seek_state', { trace_id: 't1', step, ...bad }).isError).toBe(true)
    }
  })
})

describe('run_trace output pages and the response size guard', () => {
  test('the first 100 output lines with the total, then pages by trace id', () => {
    const server = new McpServer('0')
    const first = call(server, 'run_trace', { source: CHATTY }).body
    expect(first).toMatchObject({ output_total: 250, output_offset: 0, output_truncated: true })
    expect(first.output).toHaveLength(100)
    expect(first.more_output).toContain('output_offset: 100')
    const last = call(server, 'run_trace', {
      trace_id: 't1',
      output_offset: 240,
      output_limit: 50,
    }).body
    expect(last).toMatchObject({ output_truncated: false, more_output: null, trace_id: 't1' })
    expect(last.output.map((line: { text: string }) => line.text)).toContain('line 249')
    expect(call(server, 'run_trace', { trace_id: 't1', output_offset: -5 }).isError).toBe(true)
  })

  test('an oversized result is shortened with a note instead of failing', () => {
    const server = new McpServer('0')
    const source = 'var s = "ab"\nfor i in 0..16 {\n  s = s + s\n}\nprint(len(s))\n'
    const run = call(server, 'run_trace', { source }).body
    const state = call(server, 'seek_state', { trace_id: 't1', step: run.steps - 1 })
    expect(state.isError).toBe(false)
    expect(state.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS)
    expect(state.body.truncated_by_size_guard.cut[0]).toMatch(/globals\.s: \d+ characters/)
    expect(state.body.step).toBe(run.steps - 1)
  })

  test('guardResponse keeps small results, shortens lists, texts and maps, and stubs the rest', () => {
    const small = { a: [1, 2, 3] }
    expect(guardResponse(small)).toBe(small)
    const long = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, text: `row ${i}` })) }
    const shortened = guardResponse(long, 20_000) as { rows: Json[] }
    expect(JSON.stringify(shortened).length).toBeLessThanOrEqual(20_000)
    expect(shortened.rows.length).toBeLessThan(5000)
    const wide = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${i}`, i]))
    const narrowed = guardResponse({ wide }, 10_000) as { wide: object }
    expect(Object.keys(narrowed.wide).length).toBeLessThan(4000)
    const text = guardResponse('x'.repeat(100_000), 5000) as { result: string }
    expect(text.result.endsWith('…')).toBe(true)
    const level = (inner: Json): Json =>
      Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`key${i}`, inner]))
    const dense = level(level(level('a value that is long enough to matter')))
    const stub = guardResponse(dense, 2000) as { truncated_by_size_guard: { keys: string[] } }
    expect(stub.truncated_by_size_guard.keys).toHaveLength(32)
  })

  test('jsonLiteral writes JSON as Hindsight literals', () => {
    expect(jsonLiteral([1, 'a{b}', null, true, { k: [2] }], 'v')).toBe(
      '[1, "a\\{b\\}", nil, true, {"k": [2]}]',
    )
    expect(() => jsonLiteral(Number.POSITIVE_INFINITY, 'v')).toThrow('finite')
    expect(() =>
      jsonLiteral(
        Array.from({ length: 10_001 }, () => 1),
        'v',
      ),
    ).toThrow('too large')
    expect(() => jsonLiteral(undefined, 'v')).toThrow('JSON value')
  })
})
