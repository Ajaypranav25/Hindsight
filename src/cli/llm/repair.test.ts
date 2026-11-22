import { describe, expect, test } from 'vitest'
import {
  type CallNode,
  type CallTree,
  callTree,
  compile,
  record,
  type Recording,
} from '../../core/index'
import { makeStyle } from '../format'
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic'
import { LlmClient } from './client'
import { anthropicText, type CannedReply, fakeHost } from './fake-host'
import { unifiedDiff } from './line-diff'
import { aiRepair, repairReport, verifiedSources } from './repair'
import {
  behaviorLines,
  prepareExamples,
  type RepairGoal,
  type RepairJudgment,
  repairTarget,
  shapeProblem,
  verifyCandidate,
} from './repair-verify'
import type { LlmConfig } from './types'

const CRASH =
  'fn last(xs) {\n  xs[len(xs) - 0]\n}\nlet items = [4, 5]\nlet spare = 1\nprint(last(items))\n'
const FIX = 'fn last(xs) {\n  xs[len(xs) - 1]\n}'
const STILL_CRASHES = 'fn last(xs) {\n  xs[len(xs) + 1]\n}'
const AVERAGE =
  'fn total(xs) {\n  var sum = 0\n  for x in xs { sum += x }\n  sum\n}\n' +
  'fn average(xs) {\n  total(xs) / (len(xs) + 1)\n}\n' +
  'print(average([92, 88, 95]))\nprint(total([1, 2]))\n'

const CONFIG: LlmConfig = {
  provider: 'anthropic',
  model: DEFAULT_ANTHROPIC_MODEL,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  timeoutMs: 5_000,
  maxCalls: 40,
}
const plain = makeStyle(false)

function recorded(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('compile failed')
  return record(compiled.program, { seed: 1 })
}

function callOf(tree: CallTree, name: string): CallNode {
  for (const call of tree.calls({ justMyCode: true })) if (call.name === name) return call
  throw new Error(`no call of ${name}`)
}

function lastCallOf(tree: CallTree, name: string): CallNode {
  const calls = [...tree.calls({ justMyCode: true })].filter((call) => call.name === name)
  return calls.at(-1)!
}

const candidates = (...items: [string, string][]) =>
  anthropicText({ candidates: items.map(([fn, explanation]) => ({ function: fn, explanation })) })

function client(replies: readonly CannedReply[], maxCalls = 40) {
  const host = fakeHost(replies)
  return { host, client: new LlmClient({ ...CONFIG, maxCalls }, host) }
}

/** The average program's judgments: average judged wrong (expected value known), total right. */
function averageGoal(expected: string | null = '91.66666666666667'): {
  recording: Recording
  goal: RepairGoal
} {
  const recording = recorded(AVERAGE)
  const tree = callTree(recording)
  const average = callOf(tree, 'average')
  const judgments: RepairJudgment[] = [
    { call: average, answer: 'wrong', expected, by: 'you' },
    { call: lastCallOf(tree, 'total'), answer: 'right', expected: null, by: 'you' },
  ]
  return { recording, goal: { kind: 'examples', protoId: average.protoId, judgments } }
}

describe('repairTarget and shapeProblem', () => {
  test('a crash targets the innermost function of the program at the error', () => {
    // Arrange
    const recording = recorded(CRASH)

    // Act
    const target = repairTarget(recording, { kind: 'crash' })

    // Assert
    expect(target).toMatchObject({
      name: 'last',
      declared: true,
      lines: { start: 1, end: 3 },
      text: 'fn last(xs) {\n  xs[len(xs) - 0]\n}',
    })
  })

  test('a failed precondition targets the caller that broke it (SPEC 7.16)', () => {
    // Arrange
    const recording = recorded(`fn average(xs) requires len(xs) > 0 { sum(xs) / len(xs) }
fn report(groups) { average(groups[1]) }
print(report([[1], []]))
`)
    const fromTop = recorded(`fn f(n) requires n > 0 { n }
print(f(0))
`)

    // Act
    const target = repairTarget(recording, { kind: 'crash' })

    // Assert
    expect(target).toMatchObject({ name: 'report', lines: { start: 2, end: 2 } })
    expect(repairTarget(fromTop, { kind: 'crash' })).toMatch(/top-level code/)
  })

  test('explains when there is no crash or the fault is in the top-level code', () => {
    // Arrange
    const finished = recorded('print(1)\n')
    const topLevel = recorded('let xs = [1]\nprint(xs[5])\n')

    // Act, Assert
    expect(repairTarget(finished, { kind: 'crash' })).toBe('The run did not crash.')
    expect(repairTarget(topLevel, { kind: 'crash' })).toMatch(/top-level code/)
  })

  test('a candidate must be one function of the same name, or one function value', () => {
    // Arrange
    const target = repairTarget(recorded(CRASH), { kind: 'crash' })
    const lambda = repairTarget(recorded('let f = |xs| xs[5]\nprint(f([1]))\n'), { kind: 'crash' })
    if (typeof target === 'string' || typeof lambda === 'string') throw new Error('no target')

    // Act, Assert
    expect(shapeProblem(target, FIX)).toBeNull()
    expect(shapeProblem(target, 'fn first(xs) { xs[0] }')).toBe('it renames last to first')
    expect(shapeProblem(target, `${FIX}\nfn other() { 1 }`)).toMatch(/not one function declaration/)
    expect(shapeProblem(target, 'fn last(xs) {')).toMatch(/^it does not parse: .* \(its line 1\)$/)
    expect(lambda.declared).toBe(false)
    expect(shapeProblem(lambda, '|xs| xs[0]')).toBeNull()
    expect(shapeProblem(lambda, 'let g = 1')).toBe('it is not one function')
  })
})

describe('verifyCandidate', () => {
  test('crash: a rewrite that makes the run finish is verified, with its behavior change', () => {
    // Arrange
    const recording = recorded(CRASH)
    const target = repairTarget(recording, { kind: 'crash' })
    if (typeof target === 'string') throw new Error(target)
    const context = { recording, target, goal: { kind: 'crash' as const }, examples: [], seed: 1 }

    // Act
    const fixed = verifyCandidate(context, `  ${FIX}  `)
    const still = verifyCandidate(context, STILL_CRASHES)
    const broken = verifyCandidate(context, 'fn last(xs) {\n  xs[nope]\n}')

    // Assert
    expect(fixed).toMatchObject({ verified: true, source: CRASH.replace('- 0', '- 1') })
    expect(fixed.verified && fixed.notes).toEqual([
      'the run finishes',
      'output: +5',
      expect.stringMatching(/^the difference starts in last: /),
      '2 calls changed',
    ])
    expect(still).toMatchObject({ verified: false })
    expect(!still.verified && still.reasons[0]).toMatch(/^the run still crashes with R007/)
    expect(!broken.verified && broken.reasons[0]).toMatch(
      /^the program does not compile with it: E\d+/,
    )
  })

  test('crash: a rewrite that drops or weakens the failed postcondition is rejected', () => {
    // Arrange
    const recording = recorded(
      'fn half(n)\n  ensures result * 2 == n\n{\n  n / 3\n}\nprint(half(4))\n',
    )
    const target = repairTarget(recording, { kind: 'crash' })
    if (typeof target === 'string') throw new Error(target)
    const context = { recording, target, goal: { kind: 'crash' as const }, examples: [], seed: 1 }

    // Act
    const dropped = verifyCandidate(context, 'fn half(n) { n / 3 }')
    const weakened = verifyCandidate(context, 'fn half(n)\n  ensures result > 0\n{\n  n / 3\n}')
    const fixed = verifyCandidate(context, 'fn half(n)\n  ensures result * 2 == n\n{\n  n / 2\n}')

    // Assert
    for (const check of [dropped, weakened]) {
      expect(check.verified).toBe(false)
      expect(!check.verified && check.reasons[0]).toMatch(
        /^the postcondition that failed \(result \* 2 == n, line 2\) is gone/,
      )
    }
    expect(fixed.verified).toBe(true)
  })

  test('examples: right calls must keep their results and wrong ones must return the expected value', () => {
    // Arrange
    const { recording, goal } = averageGoal()
    const target = repairTarget(recording, goal)
    if (typeof target === 'string' || goal.kind !== 'examples') throw new Error('no target')
    const examples = prepareExamples(recording, goal.judgments)
    const context = { recording, target, goal, examples, seed: 1 }

    // Act
    const right = verifyCandidate(context, 'fn average(xs) {\n  total(xs) / len(xs)\n}')
    const close = verifyCandidate(context, 'fn average(xs) {\n  total(xs) / len(xs) + 0.5\n}')
    const crashes = verifyCandidate(context, 'fn average(xs) {\n  total(xs) / xs\n}')

    // Assert
    expect(examples.map((example) => example.shown)).toEqual([
      'average(xs = [92, 88, 95])',
      'total(xs = [1, 2])',
    ])
    expect(right.verified && right.notes[0]).toBe(
      'average(xs = [92, 88, 95]) now returns 91.66666666666667, as expected',
    )
    expect(!close.verified && close.reasons).toEqual([
      'average(xs = [92, 88, 95]) should return 91.66666666666667; it now returns 92.16666666666667',
    ])
    expect(!crashes.verified && crashes.reasons[0]).toMatch(/^the run now crashes with R001/)
  })

  test('examples: without an expected value a wrong call must change; a right call must not', () => {
    // Arrange
    const { recording, goal } = averageGoal(null)
    const total = repairTarget(recording, {
      ...goal,
      protoId: callOf(callTree(recording), 'total').protoId,
    } as RepairGoal)
    const target = repairTarget(recording, goal)
    if (typeof target === 'string' || typeof total === 'string' || goal.kind !== 'examples')
      throw new Error('no target')
    const examples = prepareExamples(recording, goal.judgments)

    // Act
    const same = verifyCandidate(
      { recording, target, goal, examples, seed: 1 },
      'fn average(xs) {\n  total(xs) / (len(xs) + 1)\n}',
    )
    const breaksTotal = verifyCandidate(
      { recording, target: total, goal, examples, seed: 1 },
      'fn total(xs) {\n  0\n}',
    )

    // Assert
    expect(!same.verified && same.reasons).toEqual([
      'average(xs = [92, 88, 95]) still returns 68.75 (you judged it wrong)',
    ])
    expect(!breaksTotal.verified && breaksTotal.reasons).toContain(
      'total(xs = [1, 2]) returned 3 (you judged it right); now 0',
    )
  })

  test('behaviorLines says when nothing changed', () => {
    // Arrange
    const recording = recorded(AVERAGE)

    // Act, Assert
    expect(behaviorLines(recording, recorded(AVERAGE))).toEqual([
      'it behaves exactly as before on this run',
    ])
  })
})

describe('aiRepair', () => {
  test('one round: the verified candidate is numbered with its diff, the rejected one has reasons', async () => {
    // Arrange
    const recording = recorded(CRASH)
    const { host, client: llm } = client([
      candidates([STILL_CRASHES, 'Index past the end.'], [FIX, 'The last index is len - 1.']),
    ])

    // Act
    const result = await aiRepair(llm, recording, { kind: 'crash' }, { seed: 1 })
    const report = repairReport(result, plain, llm.model)

    // Assert
    expect(host.sent).toHaveLength(1)
    const body = host.sent[0]!.body as { system: string; messages: { content: string }[] }
    const prompt = body.messages[0]!.content
    expect(body.system).toContain('Every candidate is compiled and run by the debugger')
    expect(prompt).toContain('The program crashed in the function last.')
    expect(prompt).toContain('fn last(xs) {\n  xs[len(xs) - 0]\n}')
    expect(prompt).toMatch(/The error: R007 /)
    expect(prompt).toContain('Call stack, innermost first: last (line 2), <top level> (line 6)')
    expect(prompt).toContain('   4 | let items = [4, 5]')
    expect(prompt).not.toContain('let spare = 1')
    expect(result.rounds).toBe(1)
    expect(verifiedSources(result)).toEqual([CRASH.replace('- 0', '- 1')])
    expect(report).toContain('✓ Candidate 1: The last index is len - 1.')
    expect(report).toContain('    @@ -1,4 +1,4 @@')
    expect(report).toContain('    -  xs[len(xs) - 0]')
    expect(report).toContain('    +  xs[len(xs) - 1]')
    expect(report).toContain('✗ rejected: Index past the end.')
    expect(report.at(-1)).toBe('1 of 2 candidates verified in 1 round')
  })

  test('a second round sends the rejection reasons back; never more than two rounds', async () => {
    // Arrange
    const recording = recorded(CRASH)
    const second = client([candidates([STILL_CRASHES, 'Off by one.']), candidates([FIX, 'Fixed.'])])
    const never = client([candidates([STILL_CRASHES, 'Off by one.'])])

    // Act
    const fixed = await aiRepair(second.client, recording, { kind: 'crash' }, { seed: 1 })
    const failed = await aiRepair(never.client, recording, { kind: 'crash' }, { seed: 1 })

    // Assert
    const retry = (second.host.sent[1]!.body as { messages: { content: string }[] }).messages[0]!
    expect(retry.content).toContain('Your earlier candidates were all rejected')
    expect(retry.content).toMatch(/Rejected: the run still crashes with R007/)
    expect(fixed.rounds).toBe(2)
    expect(repairReport(fixed, plain, 'm')).toContain('✓ Candidate 1 (round 2): Fixed.')
    expect(failed.rounds).toBe(2)
    expect(never.host.sent).toHaveLength(2)
    expect(verifiedSources(failed)).toEqual([])
  })

  test('examples: the prompt lists the judged calls with what they should return', async () => {
    // Arrange
    const { recording, goal } = averageGoal()
    const { host, client: llm } = client([
      candidates(['fn average(xs) {\n  total(xs) / len(xs)\n}', 'Divide by the count.']),
    ])

    // Act
    const result = await aiRepair(llm, recording, goal, { seed: 1 })

    // Assert
    const prompt = (host.sent[0]!.body as { messages: { content: string }[] }).messages[0]!.content
    expect(prompt).toContain('isolated a bug in the function average')
    expect(prompt).toContain('Functions it calls:')
    expect(prompt).toContain('  total(xs = [1, 2]) returned 3  (you)')
    expect(prompt).toContain(
      '  average(xs = [92, 88, 95]) returned 68.75; it should return 91.66666666666667  (you)',
    )
    expect(verifiedSources(result)).toHaveLength(1)
  })

  test('reports problems, failed requests, empty answers and the cap without verifying anything', async () => {
    // Arrange
    const finished = recorded('print(1)\n')
    const recording = recorded(CRASH)
    const failing = client([{ status: 500, body: 'down' }])
    const empty = client([anthropicText({ candidates: [{ function: ' ', explanation: 'x' }, 7] })])
    const capped = client([], 0)
    const { recording: avg, goal } = averageGoal()
    const noWrong = {
      ...goal,
      judgments: goal.kind === 'examples' ? goal.judgments.slice(1) : [],
    } as RepairGoal

    // Act
    const none = await aiRepair(failing.client, finished, { kind: 'crash' }, { seed: 1 })
    const failed = await aiRepair(failing.client, recording, { kind: 'crash' }, { seed: 1 })
    const blank = await aiRepair(empty.client, recording, { kind: 'crash' }, { seed: 1 })
    const over = await aiRepair(capped.client, recording, { kind: 'crash' }, { seed: 1 })
    const nothingWrong = await aiRepair(capped.client, avg, noWrong, { seed: 1 })

    // Assert
    expect(repairReport(none, plain, 'm')).toEqual(['no AI repair: The run did not crash.'])
    expect(failed.error).toMatch(/^HTTP 500: down \(also on the retry\)$/)
    expect(repairReport(failed, plain, 'm')).toContain(
      'stopped: HTTP 500: down (also on the retry)',
    )
    expect(blank.error).toBe('the answer held no candidate')
    expect(over.error).toMatch(/the cap of 0 requests/)
    expect(nothingWrong.problem).toMatch(/No call was judged wrong/)
    expect(capped.host.sent).toHaveLength(0)
  })
})

describe('unifiedDiff', () => {
  test('one hunk with two lines of context around the changed region', () => {
    // Arrange
    const before = 'a\nb\nc\nd\ne\nf\ng\n'
    const after = 'a\nb\nc\nD\nx\ne\nf\ng\n'

    // Act
    const diff = unifiedDiff(before, after)

    // Assert
    expect(diff).toEqual(['@@ -2,5 +2,6 @@', ' b', ' c', '-d', '+D', '+x', ' e', ' f'])
    expect(unifiedDiff(before, before)).toEqual([])
  })

  test('aligns inside the region and falls back to removed-then-added past the bound', () => {
    // Arrange
    const many = Array.from({ length: 600 }, (_, i) => `line ${i}`)
    const changed = many.map((line, i) => (i % 2 === 0 ? `${line}!` : line))

    // Act
    const small = unifiedDiff('x\n1\n2\n3\ny', 'x\n1\nA\n3\ny')
    const large = unifiedDiff(many.join('\n'), changed.join('\n'))

    // Assert
    expect(small).toEqual(['@@ -1,5 +1,5 @@', ' x', ' 1', '-2', '+A', ' 3', ' y'])
    expect(large.filter((line) => line.startsWith('-'))).toHaveLength(599)
    expect(large[1]).toBe('-line 0')
    expect(large.at(-2)).toBe('+line 598!')
    expect(large.at(-1)).toBe(' line 599')
  })
})
