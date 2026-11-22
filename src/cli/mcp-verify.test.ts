import { describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../core/index'
import { McpServer } from './mcp'
import { assess, failureOf } from './mcp-verify'

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'v',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

function recorded(source: string, maxSteps?: number): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostics)}`)
  return record(result.program, { maxSteps })
}

const CRASH = 'fn last(xs) {\n  xs[len(xs) - 0]\n}\nlet items = [4, 5]\nprint(last(items))\n'
const CRASH_FIXED = CRASH.replace('len(xs) - 0', 'len(xs) - 1')
const AVERAGE =
  'fn total(scores) {\n  var sum = 0\n  for s in scores { sum += s }\n  sum\n}\n' +
  'fn average(scores) {\n  total(scores) / (len(scores) + 1)\n}\n' +
  'print(average([92, 88, 95]))\nprint(average([1, 2, 3]))\nprint(total([1, 2]))\n'
const AVERAGE_FIXED = AVERAGE.replace('len(scores) + 1', 'len(scores)')
const EXPECT_AVERAGE = [
  { call: 'average([92, 88, 95])', expected: '91.66666666666667' },
  { call: 'average([1, 2, 3])', expected: 2 },
  { call: 'total([1, 2])', expected: '3' },
]

describe('verify_patch', () => {
  test('a patch that makes a crashed run finish is fixed', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const { isError, body } = call(server, 'verify_patch', {
      source: CRASH,
      patched_source: CRASH_FIXED,
    })

    // Assert
    expect(isError).toBe(false)
    expect(body.verdict).toBe('fixed')
    expect(body.crash_fixed).toBe(true)
    expect(body.reasons[0]).toMatch(
      /^the original crashes with R007 .* on line 2; the patched run finishes$/,
    )
    expect(body.original).toMatchObject({
      trace_id: 't1',
      outcome: { kind: 'error', code: 'R007' },
    })
    expect(body.patched).toMatchObject({ trace_id: 't2', outcome: { kind: 'finished' } })
    expect(body.diff.same).toBe(false)
    expect(body.diff.output_diff).toEqual(['+ 5'])
    expect(body.contract_failures).toEqual({ original: null, patched: null })
  })

  test('expectations are judged in both runs and a patch meeting them all is fixed', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const { body } = call(server, 'verify_patch', {
      source: AVERAGE,
      patched_source: AVERAGE_FIXED,
      expectations: EXPECT_AVERAGE,
    })

    // Assert
    expect(body.verdict).toBe('fixed')
    expect(body.crash_fixed).toBe(false)
    expect(body.expectations).toHaveLength(3)
    expect(body.expectations[0]).toMatchObject({
      call: 'average([92, 88, 95])',
      a: { verdict: 'wrong', recorded: '68.75' },
      b: { verdict: 'right' },
    })
    expect(body.expectations_met_in_b).toBe(true)
    expect(body.reasons).toEqual([
      'average([92, 88, 95]) now returns 91.66666666666667',
      'average([1, 2, 3]) now returns 2',
    ])
    expect(body.diff.origins.items[0]).toMatchObject({ function: 'average' })
  })

  test('a patch that fixes some expectations but not all is improved', () => {
    // Arrange
    const server = new McpServer('0')
    const partly = AVERAGE.replace(
      'total(scores) / (len(scores) + 1)',
      'if len(scores) == 3 and scores[0] == 1 { 2 } else { total(scores) / (len(scores) + 1) }',
    )

    // Act
    const { body } = call(server, 'verify_patch', {
      source: AVERAGE,
      patched_source: partly,
      expectations: EXPECT_AVERAGE,
    })

    // Assert
    expect(body.verdict).toBe('improved')
    expect(body.reasons).toContain('average([1, 2, 3]) now returns 2')
    expect(body.reasons).toContain(
      'average([92, 88, 95]) should return 91.66666666666667; the patched run gives 68.75',
    )
  })

  test('breaking a call that was right, or crashing a run that finished, is a regression', () => {
    // Arrange
    const server = new McpServer('0')
    const broken = AVERAGE_FIXED.replace('sum += s', 'sum += s + 1')
    const crashing = AVERAGE.replace('sum\n}', 'sum[0]\n}')

    // Act
    const wrong = call(server, 'verify_patch', {
      source: AVERAGE,
      patched_source: broken,
      expectations: EXPECT_AVERAGE,
    }).body
    const crash = call(server, 'verify_patch', { source: AVERAGE, patched_source: crashing }).body

    // Assert
    expect(wrong.verdict).toBe('regressed')
    expect(wrong.reasons[0]).toBe('total([1, 2]) was right (3); now 5')
    expect(crash.verdict).toBe('regressed')
    expect(crash.reasons[0]).toMatch(
      /^the patched run crashes with R\d+ .*; the original finished$/,
    )
  })

  test('a patch that does not compile reports its errors and the original run', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const { isError, body } = call(server, 'verify_patch', {
      source: CRASH,
      patched_source: 'fn last(xs) {\n  xs[\n}\n',
    })

    // Assert
    expect(isError).toBe(false)
    expect(body.verdict).toBe('does-not-compile')
    expect(body.compile_errors.length).toBeGreaterThan(0)
    expect(body.compile_errors[0]).toMatchObject({
      line: expect.any(Number),
      code: expect.any(String),
    })
    expect(body.original.outcome.kind).toBe('error')
    expect(body.next_steps[0]).toMatch(/compile errors/)
  })

  test('the same program, or one that behaves the same, is unchanged', () => {
    // Arrange
    const server = new McpServer('0')
    const renamed = AVERAGE_FIXED.replace(/sum/g, 'acc')

    // Act
    const same = call(server, 'verify_patch', { source: CRASH, patched_source: CRASH }).body
    const quiet = call(server, 'verify_patch', {
      source: AVERAGE_FIXED,
      patched_source: renamed,
    }).body
    const differs = call(server, 'verify_patch', {
      source: AVERAGE,
      patched_source: AVERAGE_FIXED,
    }).body

    // Assert
    expect(same.verdict).toBe('unchanged')
    expect(same.reasons[0]).toBe('The patched program is the same text as the original.')
    expect(same.reasons[1]).toMatch(/^the patched run still crashes with R007/)
    expect(quiet.verdict).toBe('unchanged')
    expect(quiet.reasons).toEqual([
      'Neither run fails, and both behave the same: same outcome, output and calls.',
    ])
    expect(differs.verdict).toBe('unchanged')
    expect(differs.reasons[0]).toMatch(/give expectations to judge it/)
  })

  test('takes the original from a trace and keeps the patched run as a trace', () => {
    // Arrange
    const server = new McpServer('0')
    const traced = call(server, 'run_trace', { source: CRASH }).body

    // Act
    const { body } = call(server, 'verify_patch', {
      trace_id: traced.trace_id,
      patched_source: CRASH_FIXED,
      limit: 1,
    })
    const after = call(server, 'run_trace', { source: CRASH }).body

    // Assert
    expect(body.original.trace_id).toBe(traced.trace_id)
    expect(body.patched.trace_id).toBe('t2')
    expect(after.trace_id).toBe('t3')
  })

  test('reports the contract or assertion each run failed', () => {
    // Arrange
    const server = new McpServer('0')
    const source = 'fn half(n)\n  ensures result * 2 == n\n{\n  n / 3\n}\nprint(half(4))\n'
    const patched = source.replace('n / 3', 'n / 2')

    // Act
    const { body } = call(server, 'verify_patch', { source, patched_source: patched })

    // Assert
    expect(body.verdict).toBe('fixed')
    expect(body.contract_failures.original).toMatchObject({
      kind: 'postcondition',
      code: 'R027',
      line: 2,
    })
    expect(body.contract_failures.patched).toBeNull()
    expect(body.reasons[0]).toMatch(/^the original fails a postcondition with R027/)
  })

  test('rejects a missing or non-text patched_source and a missing original', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const noPatch = call(server, 'verify_patch', { source: CRASH, patched_source: 3 })
    const noOriginal = call(server, 'verify_patch', { patched_source: CRASH })

    // Assert
    expect(noPatch.isError).toBe(true)
    expect(noPatch.body.error).toMatch(/patched_source must be a string/)
    expect(noOriginal.isError).toBe(true)
    expect(noOriginal.body.error).toMatch(/trace_id or source/)
  })

  test('is listed, and the instructions and other tools point to it', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const listed = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as {
      result: { tools: { name: string; inputSchema: { required: string[] } }[] }
    }
    const init = server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) as {
      result: { instructions: string }
    }
    const diagnosed = call(server, 'diagnose_failure', { source: CRASH }).body

    // Assert
    const tool = listed.result.tools.find((candidate) => candidate.name === 'verify_patch')
    expect(tool?.inputSchema.required).toEqual(['patched_source'])
    expect(init.result.instructions).toMatch(/verify_patch/)
    expect(diagnosed.next_steps.join(' ')).toMatch(/verify_patch/)
  })
})

describe('assess', () => {
  test('a run that stops at the step limit is a failure of its own', () => {
    // Arrange
    const finished = recorded('print(1)\n')
    const looping = recorded('var i = 0\nwhile true { i += 1 }\n', 500)

    // Act
    const failure = failureOf(looping)
    const result = assess(finished, looping, [], true)
    const back = assess(looping, finished, [], true)

    // Assert
    expect(failure).toMatchObject({ kind: 'step-limit', text: 'hits the step limit of 500 steps' })
    expect(result).toEqual({
      verdict: 'regressed',
      reasons: ['the patched run hits the step limit of 500 steps; the original finished'],
    })
    expect(back.verdict).toBe('fixed')
  })

  test('two different failures name both; a failed assertion is named as one', () => {
    // Arrange
    const crash = recorded('let xs = [1]\nprint(xs[3])\n')
    const assertion = recorded('assert(1 == 2)\n')

    // Act
    const result = assess(crash, assertion, [], true)

    // Assert
    expect(result.verdict).toBe('unchanged')
    expect(result.reasons[0]).toMatch(
      /^the original crashes with R\d+ .* on line 2; the patched run fails an assertion with R018/,
    )
  })

  test('a fixed call next to a broken one is still a regression, listed first', () => {
    // Arrange
    const run = recorded('print(1)\n')
    const rows = [
      {
        call: 'f(1)',
        expected: '2',
        a: { recorded: '1', verdict: 'wrong' },
        b: { recorded: '2', verdict: 'right' },
      },
      {
        call: 'g(1)',
        expected: '5',
        a: { recorded: '5', verdict: 'right' },
        b: { recorded: null, verdict: 'unmatched' },
      },
    ]

    // Act
    const result = assess(run, run, rows, true)

    // Assert
    expect(result).toEqual({
      verdict: 'regressed',
      reasons: ['g(1) was right (5); now no such call', 'f(1) now returns 2'],
    })
  })
})
