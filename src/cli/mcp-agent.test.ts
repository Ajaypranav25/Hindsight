import { describe, expect, test } from 'vitest'
import { callTree, compile, record, type Recording } from '../core/index'
import { McpServer } from './mcp'
import { questionId, replayInterview } from './mcp-find-bug'
import { setting } from './mcp-diff'
import { readsOf } from './mcp-diagnose'

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'a',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

function recorded(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program)
}

const CRASH =
  'fn last(xs) {\n  xs[len(xs) - 0]\n}\nlet items = [4, 5]\nlet spare = 1\nprint(last(items))\n'
const AVERAGE =
  'fn total(scores) {\n  var sum = 0\n  for s in scores { sum += s }\n  sum\n}\n' +
  'fn average(scores) {\n  total(scores) / (len(scores) + 1)\n}\n' +
  'let scores = [92, 88, 95]\nprint(average(scores))\nprint(average([1, 2, 3]))\n'
const FIXED = AVERAGE.replace('len(scores) + 1', 'len(scores)')
const LOOP = 'var i = 0\nvar n = 1\nwhile i < 10 {\n  n = n * 1\n}\n'

describe('diagnose_failure', () => {
  test('a crash in one call: error, stack, values read, slice, causal chain and repairs', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const { isError, body } = call(server, 'diagnose_failure', { source: CRASH })

    // Assert
    expect(isError).toBe(false)
    expect(body).toMatchObject({
      trace_id: 't1',
      status: 'crashed',
      error: { code: 'R007', line: 2, column: 3, source_line: '  xs[len(xs) - 0]' },
      statement: { function: 'last', line: 2, text: 'xs[len(xs) - 0]' },
      values: { xs: { type: 'list', items: [4, 5] } },
    })
    expect(body.stack.map((entry: { function: string }) => entry.function)).toEqual([
      'last',
      '<top level>',
    ])
    expect(body.stack[1]).toMatchObject({ line: 6, source_line: 'print(last(items))' })
    expect(body.slice.lines).toContainEqual({ line: 4, text: 'let items = [4, 5]' })
    expect(body.slice.lines_ruled_out).toEqual([5])
    expect(body.causal_chain).toContainEqual({
      name: 'items',
      value: { object: expect.any(Number), type: 'list', text: '[4, 5]' },
      step: expect.any(Number),
      line: 4,
    })
    expect(body.causal_chain.map((write: { name: string }) => write.name)).not.toContain('last')
    expect(body.repairs.candidates[0]).toMatchObject({
      line: 2,
      change: '`0` → `1`',
      after: 'xs[len(xs) - 1]',
      now: ['the run finishes'],
    })
    expect(body.repairs.mutants_checked).toBeGreaterThan(0)
    expect(body.next_steps.join(' ')).toContain('query_provenance')
  })

  test('a wrong output line: the print statement, its slice and inverse candidates', () => {
    const server = new McpServer('0')
    call(server, 'run_trace', { source: AVERAGE })
    const { body } = call(server, 'diagnose_failure', {
      trace_id: 't1',
      output_index: 0,
      expected: '91.66666666666667',
    })
    expect(body).toMatchObject({
      status: 'wrong-output',
      output: { index: 0, line_number: 1, text: '68.75', expected: '91.66666666666667' },
      statement: { line: 10, text: 'print(average(scores))' },
      values: { scores: { type: 'list', items: [92, 88, 95] } },
    })
    expect(body.values.average).toBeUndefined()
    expect(body.slice.lines.map((line: { line: number }) => line.line)).toContain(7)
    expect(body.inverse).toMatchObject({ candidates_tried: expect.any(Number) })
    const second = call(server, 'diagnose_failure', { trace_id: 't1', output_line: 2 }).body
    expect(second).toMatchObject({
      output: { index: 1, text: '1.5', expected: null },
      inverse: null,
    })
    expect(call(server, 'diagnose_failure', { trace_id: 't1', output_index: 2 }).isError).toBe(true)
  })

  test('a run that finished, one at the step limit, and runs that print nothing', () => {
    const server = new McpServer('0')
    expect(call(server, 'diagnose_failure', { source: AVERAGE }).body).toMatchObject({
      status: 'finished',
      output_lines: 2,
    })
    const stuck = call(server, 'diagnose_failure', { source: LOOP, max_steps: 500 }).body
    expect(stuck).toMatchObject({ status: 'step-limit', stack: [{ function: '<top level>' }] })
    expect(stuck.hottest_lines[0]).toMatchObject({ hits: expect.any(Number) })
    expect([3, 4]).toContain(stuck.hottest_lines[0].line)
    const quiet = { source: 'let a = 1\n' }
    expect(call(server, 'diagnose_failure', { ...quiet, output_index: 0 }).isError).toBe(true)
    expect(call(server, 'diagnose_failure', { ...quiet, output_line: 1 }).isError).toBe(true)
    expect(call(server, 'diagnose_failure', {}).isError).toBe(true)
  })

  test('readsOf names the variables a statement reads, not fields or record keys', () => {
    const source = 'let r = {total: a + b.c}'
    expect(readsOf(source, { start: 0, end: source.length })).toEqual(['r', 'a', 'b'])
  })
})

describe('diff_runs', () => {
  test('two versions of a program: output diff and the origin in average', () => {
    const server = new McpServer('0')
    const { body } = call(server, 'diff_runs', { source_a: AVERAGE, source_b: FIXED })
    expect(body).toMatchObject({
      same: false,
      same_outcome: true,
      a: { trace_id: 't1', outcome: { kind: 'finished' }, calls: 5 },
      b: { trace_id: 't2' },
      output_diff: ['- 68.75', '- 1.5', '+ 91.66666666666667', '+ 2'],
      origins: { total: 2, truncated: false },
    })
    expect(body.summary).toContain('The difference starts in average (lines 6–8 of B)')
    expect(body.origins.items[0]).toMatchObject({
      function: 'average',
      lines_a: { start: 6, end: 8 },
      a: { call: 'average(scores = [92, 88, 95])', did: 'returned 68.75' },
      b: { did: 'returned 91.66666666666667' },
    })
    // The traces are kept: look inside either run with the other tools.
    expect(call(server, 'seek_state', { trace_id: 't2', step: 0 }).isError).toBe(false)
    const again = call(server, 'diff_runs', { trace_a: 't1', trace_b: 't2', limit: 1 }).body
    expect(again.origins).toMatchObject({ total: 2, truncated: true })
    expect(again.origins.items).toHaveLength(1)
    expect(call(server, 'diff_runs', { trace_a: 't1', trace_b: 't1' }).body).toMatchObject({
      same: true,
      summary: expect.stringContaining('behave the same'),
    })
  })

  test('one program with an input changed, as an object or NAME=VALUE', () => {
    const server = new McpServer('0')
    const { body } = call(server, 'diff_runs', {
      source: AVERAGE,
      set: { name: 'scores', value: '[10, 20]' },
    })
    expect(body).toMatchObject({
      input: { name: 'scores', line: 9, was: '[92, 88, 95]', now: '[10, 20]' },
      same: false,
    })
    expect(body.summary).toContain('The difference starts at the input: scores = [10, 20]')
    call(server, 'run_trace', { source: 'let label = "a"\nprint(label)\n' })
    const text = call(server, 'diff_runs', { trace_id: 't3', set: { name: 'label', value: 'b' } })
    expect(text.body.output_diff).toEqual(['- a', '+ b'])
    const numeric = call(server, 'diff_runs', { source: AVERAGE, set: 'scores=[92, 88, 95]' })
    expect(numeric.body.same).toBe(true)
  })

  test('set values: literals, text and JSON primitives', () => {
    expect(setting('n=5')).toEqual({ name: 'n', value: '5' })
    expect(setting({ name: 'n', value: 2.5 })).toEqual({ name: 'n', value: '2.5' })
    expect(setting({ name: 'n', value: null })).toEqual({ name: 'n', value: 'nil' })
    expect(setting({ name: 's', value: 'hello' })).toEqual({ name: 's', value: '"hello"' })
    expect(setting({ name: 's', value: '"hi"' })).toEqual({ name: 's', value: '"hi"' })
    expect(setting({ name: 'xs', value: '[1, 2' })).toEqual({ name: 'xs', value: '[1, 2' })
    expect(setting({ name: 'xs', value: [1, { a: null }] })).toEqual({
      name: 'xs',
      value: '[1, {"a": nil}]',
    })
    for (const bad of ['=5', 7, [], { name: '', value: 1 }, { name: 'n' }]) {
      expect(() => setting(bad)).toThrow()
    }
    expect(() => setting({ name: 'n', value: Number.NaN })).toThrow()
  })

  test('bad calls are tool errors', () => {
    const server = new McpServer('0')
    for (const args of [
      {},
      { source_a: AVERAGE },
      { source: AVERAGE, set: { name: 'nope', value: '1' } },
      { source: AVERAGE, set: { name: 'scores', value: '[1, 2' } },
      { source_a: AVERAGE, source_b: 'let = 1' },
      { source: 'fn f() { 1 }\nlet x = 1\nprint(x)\n', set: 'x=f(' },
      { trace_a: 't9', trace_b: 't1' },
    ]) {
      expect(call(server, 'diff_runs', args).isError).toBe(true)
    }
  })
})

describe('suggest_repairs', () => {
  test('crash mode: patches that make the run finish', () => {
    const server = new McpServer('0')
    const { body } = call(server, 'suggest_repairs', { source: CRASH })
    expect(body).toMatchObject({ mode: 'crash', budget_exhausted: false })
    expect(body.repairs[0]).toMatchObject({ change: '`0` → `1`', before: 'xs[len(xs) - 0]' })
    const finished = call(server, 'suggest_repairs', { source: AVERAGE, mode: 'crash' })
    expect(finished.isError).toBe(true)
    expect(finished.body.error).toContain('mode "examples"')
  })

  test('examples mode: expectations in both forms judge the recorded calls', () => {
    const server = new McpServer('0')
    const { body } = call(server, 'suggest_repairs', {
      source: AVERAGE,
      expectations: [
        { call: 'average([92,88,95])', expected: '91.66666666666667' },
        { function: 'average', args: ['[1, 2, 3]'], returns: 2 },
        { function: 'total', args: [[5]], returns: 5 },
      ],
    })
    expect(body.judged).toEqual([
      expect.objectContaining({ expectation: 1, recorded: '68.75', verdict: 'wrong' }),
      expect.objectContaining({ expectation: 2, recorded: '1.5', verdict: 'wrong' }),
    ])
    expect(body.unmatched).toEqual([
      expect.objectContaining({ expectation: 3, reason: 'no call of total had these arguments' }),
    ])
    expect(body.function).toBe('average')
    const fix = body.repairs.find((repair: { change: string }) => repair.change === '`1` → `0`')
    expect(fix.now).toEqual([
      'average(scores = [92, 88, 95]) now returned 91.66666666666667',
      'average(scores = [1, 2, 3]) now returned 2',
    ])
    expect(body.mutants_checked).toBeGreaterThan(0)
  })

  test('right calls, unknown functions and malformed expectations', () => {
    const server = new McpServer('0')
    const right = call(server, 'suggest_repairs', {
      source: AVERAGE,
      expectations: [{ call: 'total([92, 88, 95])', expected: 275 }],
    })
    expect(right.body).toMatchObject({ repairs: [], judged: [{ verdict: 'right' }] })
    const missing = call(server, 'suggest_repairs', {
      trace_id: 't1',
      expectations: [{ call: 'nope(1)', expected: 1 }],
    })
    expect(missing.body.unmatched[0].reason).toBe('no call of nope was recorded')
    for (const expectations of [
      [],
      'x',
      [5],
      [{ call: 'average(' }],
      [{ call: 'a + b', expected: 1 }],
      [{ function: 'average', expected: 1 }],
      [{ call: 'average([1])', expected: Number.NaN }],
    ]) {
      expect(call(server, 'suggest_repairs', { trace_id: 't1', expectations }).isError).toBe(true)
    }
  })

  test('several functions judged wrong need a function to choose', () => {
    const server = new McpServer('0')
    const expectations = [
      { call: 'average([1, 2, 3])', expected: 2 },
      { call: 'total([1, 2, 3])', expected: 7 },
    ]
    const ambiguous = call(server, 'suggest_repairs', { source: AVERAGE, expectations })
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.body.error).toContain('give function')
    const chosen = call(server, 'suggest_repairs', {
      trace_id: 't1',
      expectations,
      function: 'average',
    })
    expect(chosen.body.function).toBe('average')
    const wrongName = call(server, 'suggest_repairs', {
      trace_id: 't1',
      expectations,
      function: 'nope',
    })
    expect(wrongName.isError).toBe(true)
  })
})

describe('find_bug', () => {
  const answerAll = (server: McpServer, strategy: string) => {
    let reply = call(server, 'find_bug', { source: AVERAGE, strategy }).body
    const answers: { question: string; answer: string }[] = []
    const asked: string[] = []
    while (reply.status === 'question' && answers.length < 10) {
      const { id, function: name } = reply.question
      asked.push(name)
      answers.push({ question: id, answer: name === 'total' ? 'right' : 'wrong' })
      reply = call(server, 'find_bug', { trace_id: reply.trace_id, strategy, answers }).body
    }
    return { reply, asked, answers }
  }

  test('a stateless interview ends with the verdict and repair previews', () => {
    const server = new McpServer('0')
    const first = call(server, 'find_bug', { source: AVERAGE }).body
    expect(first).toMatchObject({
      status: 'question',
      strategy: 'divide',
      questions_answered: 0,
      question: {
        id: expect.stringMatching(/^average#[0-9a-f]{8}$/),
        call: 'average(scores = [92, 88, 95])',
        result: 'returned 68.75',
      },
      suspects_remaining: 5,
    })
    expect(first.how_to_answer).toContain(first.question.id)
    // The same question again: ids are stable across calls.
    expect(call(server, 'find_bug', { trace_id: 't1' }).body.question.id).toBe(first.question.id)
    const { reply } = answerAll(server, 'divide')
    expect(reply).toMatchObject({
      status: 'verdict',
      verdict: { function: 'average', lines: { start: 6, end: 8 }, certainty: 'certain' },
    })
    expect(reply.verdict.code).toContainEqual({
      line: 7,
      text: '  total(scores) / (len(scores) + 1)',
    })
    expect(reply.repairs.candidates.map((repair: { change: string }) => repair.change)).toContain(
      '`1` → `0`',
    )
  })

  test('top-down asks in execution order; unused answers are reported', () => {
    const server = new McpServer('0')
    const { reply, asked } = answerAll(server, 'top-down')
    expect(asked[0]).toBe('average')
    expect(reply.status).toBe('verdict')
    const stale = call(server, 'find_bug', {
      trace_id: 't1',
      answers: [{ question: 'gone#00000000', answer: 'right' }],
    }).body
    expect(stale).toMatchObject({ status: 'question', unused_answers: ['gone#00000000'] })
  })

  test('a crashed run says where to start; bad answers are tool errors', () => {
    const server = new McpServer('0')
    const crashed = call(server, 'find_bug', { source: CRASH }).body
    expect(crashed.note).toContain('diagnose_failure')
    for (const answers of [
      'x',
      [{ answer: 'right' }],
      [{ question: 'a', answer: 'maybe' }],
      Array.from({ length: 1001 }, () => ({ question: 'a', answer: 'right' })),
    ]) {
      expect(call(server, 'find_bug', { trace_id: 't1', answers }).isError).toBe(true)
    }
    expect(call(server, 'find_bug', { trace_id: 't1', strategy: 'sideways' }).isError).toBe(true)
  })

  test('expectations answer the questions about the calls they match', () => {
    const server = new McpServer('0')
    const { body } = call(server, 'find_bug', {
      source: AVERAGE,
      expectations: [
        { call: 'average([92, 88, 95])', expected: '91.66666666666667' },
        { call: 'total([92, 88, 95])', expected: 275 },
        { call: 'total([0])', expected: 0 },
      ],
    })
    expect(body).toMatchObject({
      status: 'verdict',
      questions_answered: 2,
      verdict: { function: 'average' },
    })
    expect(body.answered_from_expectations).toEqual([
      { question: expect.stringMatching(/^average#/), answer: 'wrong' },
      { question: expect.stringMatching(/^total#/), answer: 'right' },
    ])
    const partial = call(server, 'find_bug', {
      trace_id: 't1',
      expectations: [{ call: 'total([1, 2, 3])', expected: 6 }],
    }).body
    expect(partial).toMatchObject({ status: 'question', question: { function: 'average' } })
    expect(
      call(server, 'find_bug', { trace_id: 't1', expectations: [{ call: 'x(' }] }).isError,
    ).toBe(true)
  })

  test('an oracle answers questions without the agent', () => {
    const tree = callTree(recorded(AVERAGE))
    const interview = replayInterview(tree, new Map(), {
      oracle: (details) => (details.call.name === 'total' ? 'right' : 'wrong'),
    })
    expect(interview.open).toBeNull()
    expect(interview.auto.length).toBeGreaterThan(0)
    expect(interview.state.suspect.name).toBe('average')
    const asked = replayInterview(tree, new Map(), { oracle: () => null })
    expect(asked.open).not.toBeNull()
    expect(questionId(tree, asked.open!)).toMatch(/#[0-9a-f]{8}$/)
    expect(questionId(tree, tree.root)).toMatch(/^top[#@]/)
  })
})
