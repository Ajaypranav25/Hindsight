import { describe, expect, test } from 'vitest'
import { type CallNode, type CallTree, callTree, compile, record } from '../../core/index'
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic'
import { LlmClient } from './client'
import { anthropicText, type CannedReply, fakeHost } from './fake-host'
import { LlmOracle, predictionRequest } from './oracle'
import type { LlmConfig } from './types'

const PROGRAM = `// Adds up the scores.
fn total(xs) {
  var sum = 0
  for x in xs { sum += x }
  sum
}
fn average(xs) {
  total(xs) / (len(xs) + 1)
}
var log = []
fn noted(x) {
  push(log, x)
  x
}
fn twice(f) { |x| f(f(x)) }
print(average([92, 88, 95]))
print(noted(4))
print(twice(|x| x + 1)(1))
`

const CONFIG: LlmConfig = {
  provider: 'anthropic',
  model: DEFAULT_ANTHROPIC_MODEL,
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  timeoutMs: 5_000,
  maxCalls: 40,
}

function treeOf(source: string): CallTree {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('compile failed')
  return callTree(record(compiled.program))
}

function callOf(tree: CallTree, name: string): CallNode {
  for (const call of tree.calls({ justMyCode: true })) if (call.name === name) return call
  throw new Error(`no call of ${name}`)
}

function oracle(replies: readonly CannedReply[], maxCalls = 40, minConfidence = 0.8) {
  const host = fakeHost(replies)
  const client = new LlmClient({ ...CONFIG, maxCalls }, host)
  const tree = treeOf(PROGRAM)
  return { host, client, tree, oracle: new LlmOracle(client, tree, minConfidence) }
}

const say = (expected: string | null, confidence = 0.95, why = 'Adds the numbers.') =>
  anthropicText({ expected, confidence, why })

describe('predictionRequest', () => {
  test('shows the function with its comment, its helpers and the arguments, never the result', () => {
    // Arrange
    const tree = treeOf(PROGRAM)

    // Act
    const request = predictionRequest(tree, callOf(tree, 'average'))!

    // Assert
    expect(request.prompt).toContain('fn average(xs) {\n  total(xs) / (len(xs) + 1)\n}')
    expect(request.prompt).toContain('// Adds up the scores.\nfn total(xs) {')
    expect(request.prompt).toContain('The call: average(xs = [92, 88, 95])')
    expect(request.prompt).not.toContain('68.75')
    expect(request.system).toContain('do not trace its code')
    expect(request.system).toContain('Hindsight is a small dynamically typed language')
    expect(request.schema).toMatchObject({ required: ['expected', 'confidence', 'why'] })
  })
})

describe('LlmOracle', () => {
  test('a confident prediction that differs from the result answers wrong, with its evidence', async () => {
    // Arrange
    const { oracle: llm, tree, host } = oracle([say('91.66666666666667')])
    const call = callOf(tree, 'average')

    // Act
    const consultation = await llm.consult(call)

    // Assert
    expect(consultation).toEqual({
      kind: 'answer',
      auto: {
        answer: 'wrong',
        reason: `${DEFAULT_ANTHROPIC_MODEL} expected 91.66666666666667, confidence 0.95`,
        line: null,
      },
      expected: '91.66666666666667',
      why: 'Adds the numbers.',
    })
    expect(llm.answer(call)?.answer).toBe('wrong')
    expect(host.sent).toHaveLength(1)
  })

  test('a prediction equal to the result (within the tolerance) answers right, once per memo key', async () => {
    // Arrange
    const { oracle: llm, tree, host } = oracle([say('275.0000000000001', 1)])
    const call = callOf(tree, 'total')

    // Act
    const first = await llm.consult(call)
    const again = await llm.consult(call)

    // Assert
    expect(first).toMatchObject({
      kind: 'answer',
      auto: { answer: 'right' },
      expected: '275.0000000000001',
    })
    expect(again).toBe(first)
    expect(llm.has(call)).toBe(true)
    expect(host.sent).toHaveLength(1)
  })

  test('leaves the call to the person when the model is unsure or cannot say', async () => {
    // Arrange
    const unsure = oracle([say('275', 0.6)])
    const silent = oracle([say(null, 0.9)])

    // Act
    const low = await unsure.oracle.consult(callOf(unsure.tree, 'total'))
    const none = await silent.oracle.consult(callOf(silent.tree, 'total'))

    // Assert
    expect(low).toEqual({
      kind: 'abstain',
      reason: `${DEFAULT_ANTHROPIC_MODEL} expected 275 but is not sure (confidence 0.60, below 0.80)`,
      expected: '275',
    })
    expect(unsure.oracle.answer(callOf(unsure.tree, 'total'))).toBeNull()
    expect(none).toMatchObject({
      kind: 'abstain',
      reason: `${DEFAULT_ANTHROPIC_MODEL} could not say`,
    })
  })

  test('leaves the call to the person when the prediction is not a value or not comparable', async () => {
    // Arrange
    const garbage = oracle([say('about 91')])
    const shapeless = oracle([anthropicText({ value: 3 })])
    const prose = oracle([anthropicText('I think it is 91.')])
    const fn = oracle([say('|x| x + 2')])

    // Act
    const notValue = await garbage.oracle.consult(callOf(garbage.tree, 'average'))
    const noShape = await shapeless.oracle.consult(callOf(shapeless.tree, 'average'))
    const noJson = await prose.oracle.consult(callOf(prose.tree, 'average'))
    const incomparable = await fn.oracle.consult(callOf(fn.tree, 'twice'))

    // Assert
    expect(notValue).toMatchObject({ kind: 'abstain' })
    expect((notValue as { reason: string }).reason).toMatch(/"about 91" is not a value/)
    expect(noShape).toMatchObject({
      reason: `${DEFAULT_ANTHROPIC_MODEL}'s answer did not have the asked shape`,
    })
    expect((noJson as { reason: string }).reason).toMatch(
      /gave no usable answer: the answer was not a JSON object/,
    )
    expect((incomparable as { reason: string }).reason).toMatch(/cannot be compared/)
  })

  test('a matching result of a call with side effects is left to the person; a different one is wrong', async () => {
    // Arrange
    const same = oracle([say('4')])
    const other = oracle([say('5')])

    // Act
    const matching = await same.oracle.consult(callOf(same.tree, 'noted'))
    const differing = await other.oracle.consult(callOf(other.tree, 'noted'))

    // Assert
    expect(matching).toMatchObject({ kind: 'abstain', expected: '4' })
    expect((matching as { reason: string }).reason).toMatch(/changed things outside itself/)
    expect(differing).toMatchObject({ kind: 'answer', auto: { answer: 'wrong' } })
  })

  test('failed requests and the cap leave calls to the person; nothing is sent past the cap', async () => {
    // Arrange
    const failing = oracle([
      { status: 400, body: { error: { type: 'invalid_request_error', message: 'bad' } } },
    ])
    const capped = oracle([say('275')], 1)

    // Act
    const failed = await failing.oracle.consult(callOf(failing.tree, 'total'))
    await capped.oracle.consult(callOf(capped.tree, 'total'))
    const over = await capped.oracle.consult(callOf(capped.tree, 'average'))

    // Assert
    expect((failed as { reason: string }).reason).toMatch(
      /gave no usable answer: HTTP 400 invalid_request_error: bad/,
    )
    expect(over).toEqual({
      kind: 'abstain',
      reason: 'the cap of 1 requests is reached',
      expected: null,
    })
    expect(capped.host.sent).toHaveLength(1)
  })

  test('asks nothing about a call that did not return or whose code is not in the program', async () => {
    // Arrange
    const tree = treeOf('fn boom(xs) { xs[5] }\nprint(boom([1]))\n')
    const host = fakeHost([say('1')])
    const llm = new LlmOracle(new LlmClient(CONFIG, host), tree, 0.8)

    // Act
    const raised = await llm.consult(callOf(tree, 'boom'))
    const root = predictionRequest(tree, tree.root)

    // Assert
    expect(raised).toMatchObject({ kind: 'abstain', reason: 'the call did not return a value' })
    expect(root).toBeNull()
    expect(host.sent).toHaveLength(0)
  })
})
