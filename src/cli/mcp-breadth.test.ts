import { describe, expect, test } from 'vitest'
import { callEffects } from '../core/call-effects'
import { callTree } from '../core/calls'
import { backwardSlice, compile, record, type Recording, upstreamWrites } from '../core/index'
import type { CliIO } from './io'
import { main } from './main'
import { McpServer } from './mcp'

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

const CRASH =
  'let xs = [1, 2, 3]\nlet who = {name: "ada", tags: xs}\nlet i = 5\nprint("start")\nprint(xs[i])\n'
const QUIET = 'let a = 1\nlet b = a + 1\n'

describe('MCP tools on runs that fail, print nothing, or hold objects', () => {
  test('a failed run: outcome, state at the error, slice and solve defaults', () => {
    const server = new McpServer('0')
    const run = call(server, 'run_trace', { source: CRASH, seed: 7, max_steps: 5000 })
    expect(run.body.outcome).toMatchObject({ kind: 'error', line: 5, code: expect.any(String) })
    const end = call(server, 'seek_state', { trace_id: 't1', step: run.body.steps })
    expect(end.body.error).toMatchObject({ code: run.body.outcome.code })
    expect(end.body.globals.who).toMatchObject({ type: 'record', preview: expect.any(String) })
    expect(end.body.last_output).toEqual(['start'])
    const start = call(server, 'seek_state', { trace_id: 't1', step: 0 })
    expect(start.body.location).toMatchObject({ line: 1, depth: 0 })
    expect(call(server, 'slice', { trace_id: 't1' }).body).toMatchObject({ step: run.body.steps })
    expect(call(server, 'slice', { trace_id: 't1', step: 3 }).body.step).toBe(3)
    const avoided = call(server, 'solve', { trace_id: 't1', no_crash: true })
    expect(avoided.body.solutions[0]).toMatchObject({ name: 'i', original: 5 })
    const provenance = call(server, 'query_provenance', { trace_id: 't1', step: 20, name: 'who' })
    expect(provenance.body.value).toMatchObject({ object: expect.any(Number) })
    expect(provenance.body.origin.value).toMatchObject({ object: expect.any(Number) })
    expect(call(server, 'solve', { trace_id: 't1', want: 'begin', output_line: 1 }).isError).toBe(
      true,
    )
  })

  test('a run that prints nothing needs a step to slice; finished runs have no end location', () => {
    const server = new McpServer('0')
    const run = call(server, 'run_trace', { source: QUIET })
    expect(call(server, 'slice', { trace_id: 't1' }).isError).toBe(true)
    const end = call(server, 'seek_state', { trace_id: 't1', step: run.body.steps })
    expect(end.body).toMatchObject({ location: null, frames: [], error: null })
    expect(call(server, 'why_not', { trace_id: 't1', line: 'x' }).isError).toBe(true)
    expect(call(server, 'run_trace', { source: 'x'.repeat(200_001) }).isError).toBe(true)
    expect(call(server, 'run_trace', { source: QUIET, max_steps: 1.5 }).isError).toBe(true)
  })

  test('queries of each kind, limits, and forks with every primitive', () => {
    const server = new McpServer('0')
    const source =
      'fn sq(n) { n * n }\nvar label = "a"\nvar on = false\nvar gone = 1\nvar total = 0\n' +
      'for i in 1..=3 { total += sq(i) }\nprint("{label} {on} {gone} {total}")\n'
    const run = call(server, 'run_trace', { source })
    expect(
      call(server, 'query', { trace_id: 't1', query: 'when total > 1', limit: 1 }).body,
    ).toMatchObject({ kind: 'when', intervals: [{ line: expect.any(Number) }] })
    expect(
      call(server, 'query', { trace_id: 't1', query: 'calls(sq)', limit: 5000 }).body.total,
    ).toBe(3)
    expect(
      call(server, 'query', { trace_id: 't1', query: 'changed(total)' }).body.events,
    ).toHaveLength(4)
    const step = 10
    for (const [name, value] of [
      ['label', 'b'],
      ['on', true],
      ['gone', null],
    ] as const) {
      const fork = call(server, 'fork_whatif', { trace_id: 't1', step, name, value })
      expect(fork.isError).toBe(false)
    }
    expect(
      call(server, 'get_divergence', { trace_id: 't3', base_trace_id: 't2' }).body,
    ).toMatchObject({
      divergence_step: expect.any(Number),
    })
    call(server, 'run_trace', { source: QUIET })
    expect(call(server, 'get_divergence', { trace_id: 't2', base_trace_id: 't5' }).isError).toBe(
      true,
    )
    expect(
      call(server, 'fork_whatif', { trace_id: 't1', step: run.body.steps, name: 'on', value: 1 })
        .isError,
    ).toBe(true)
  })

  test('messages with odd shapes', () => {
    const server = new McpServer('0')
    expect(server.handle([])).toMatchObject({ error: { code: -32600 } })
    expect(server.handle({ jsonrpc: '2.0', id: null, method: 'ping' })).toBeNull()
    expect(server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 5 })).toMatchObject(
      {
        result: { isError: true },
      },
    )
    expect(
      server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_trace' } }),
    ).toMatchObject({ result: { isError: true } })
    expect(
      server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    ).toMatchObject({ result: { protocolVersion: '2024-11-05' } })
  })
})

describe('call effects of many kinds', () => {
  test('deletes, element writes, strings, objects and functions as new values', () => {
    const source =
      'let box = {items: [1, 2], note: "x", f: nil}\nvar name = "a"\n' +
      'fn touch() {\n  box.items[0] = 9\n  delete(box, "note")\n  box.f = |n| n\n  box.extra = [1]\n  box.inner = {a: 1}\n  name = "a longer name"\n  nil\n}\ntouch()\n'
    const tree = callTree(recorded(source))
    const touch = [...tree.calls()].find((node) => node.name === 'touch')!
    const texts = callEffects(tree.recording, touch).effects.map((effect) => effect.text)
    expect(texts).toEqual(
      expect.arrayContaining([
        'box.note was deleted',
        'box.f became a function',
        'box.extra became a list',
        'box.inner became a record',
        'global name became "a longer name"',
        'box.items changed (1 change)',
      ]),
    )
    expect(callEffects(tree.recording, tree.root).effects).toEqual([])
  })

  test('a variable captured two closures up, and a closed cell', () => {
    const source =
      'fn outer() {\n  var n = 0\n  fn mid() {\n    fn inner() { n += 1 }\n    inner()\n  }\n  mid()\n  mid\n}\nlet later = outer()\nlater()\n'
    const tree = callTree(recorded(source))
    const inners = [...tree.calls()].filter((node) => node.name === 'inner')
    expect(inners).toHaveLength(2)
    for (const inner of inners) {
      const [effect] = callEffects(tree.recording, inner).effects
      expect(effect).toMatchObject({ kind: 'captured' })
      expect(effect!.text).toMatch(/^captured \w+ became \d$/)
    }
  })
})

describe('slices through what-if edits and upstream names', () => {
  test('edits of a local, a captured variable and a field start their own chains', () => {
    const source =
      'fn f(a) {\n  var kept = a\n  let g = |x| kept + x\n  let r = {v: a}\n  let out = g(1) + r.v\n  out\n}\nprint(f(2))\n'
    const real = recorded(source)
    const at = real.lineHits(5)[0]!
    const frame = real.stateAt(at).frames.at(-1)!
    const kept = frame.locals.find((local) => local.name === 'kept')!
    const r = frame.locals.find((local) => local.name === 'r')!
    if (r.value.kind !== 'ref') throw new Error('r is not an object')
    for (const target of [
      kept.target,
      frame.locals.find((local) => local.name === 'a')!.target,
      { kind: 'field', objectId: r.value.id, key: 'v' } as const,
    ]) {
      const fork = real.fork(at, { target, value: 40 })
      if (!fork.ok) throw new Error(fork.error.message)
      const slice = backwardSlice(fork.recording, fork.recording.outputs[0]!.time)!
      expect(slice.steps).toBeGreaterThan(0)
      expect(upstreamWrites(fork.recording, slice).length).toBeGreaterThan(0)
    }
  })

  test('upstream writes name fields, elements, captured variables and parameters', () => {
    const source =
      'let r = {a: 1}\nlet xs = [0]\nfn make() {\n  var c = 1\n  fn(p) {\n    c = c + p\n    c\n  }\n}\n' +
      'let add = make()\nr.a = 5\nxs[0] = r.a\nprint(add(xs[0]))\n'
    const recording = recorded(source)
    const slice = backwardSlice(recording, recording.outputs[0]!.time)!
    const names = upstreamWrites(recording, slice).map((write) => write.name)
    expect(names).toEqual(expect.arrayContaining(['.a', '[0]', 'c', 'p', 'r', 'xs', 'add']))
  })
})

describe('commands with colour, and files that cannot be read', () => {
  const io = (files: Record<string, string>): CliIO & { out: string[]; err: string[] } => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      color: true,
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

  test('every lab command reports a missing or broken file with exit 1', () => {
    for (const args of [
      ['solve', 'x.sight', '--no-crash'],
      ['query', 'x.sight', 'when true'],
      ['whynot', 'x.sight', '--line', '1'],
      ['slice', 'x.sight'],
      ['repair', 'x.sight'],
    ]) {
      const terminal = io({})
      expect(main(args, terminal)).toBe(1)
      expect(terminal.err.join('')).toContain("cannot read 'x.sight'")
    }
    expect(main(['slice', 'b.sight'], io({ 'b.sight': 'let = 1\n' }))).toBe(1)
  })

  test('output is styled when the terminal takes colour', () => {
    const terminal = io({ 'c.sight': CRASH })
    expect(main(['slice', 'c.sight'], terminal)).toBe(0)
    expect(terminal.out.join('')).toContain('\u001b[')
    const solved = io({ 'c.sight': CRASH })
    expect(main(['solve', 'c.sight', '--no-crash'], solved)).toBe(0)
    expect(solved.out.join('')).toContain('the run would not have failed on line 5')
  })
})
