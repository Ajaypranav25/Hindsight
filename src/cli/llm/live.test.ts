/**
 * An optional smoke test against the real Anthropic API. It runs only when ANTHROPIC_API_KEY is
 * set AND HINDSIGHT_LLM_LIVE=1 (so a key in the shell never makes `npm test` spend money by
 * itself); otherwise it is skipped. One request, a handful of tokens.
 */
import { describe, expect, test } from 'vitest'
import { callTree, compile, record } from '../../core/index'
import { nodeLlmHost } from '../ai'
import { LlmClient } from './client'
import { resolveLlmConfig } from './config'
import { LlmOracle } from './oracle'

const live = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.HINDSIGHT_LLM_LIVE === '1'

describe.skipIf(!live)('the real Anthropic API', () => {
  test('predicts what an obvious function should return, and the VM judges the call', async () => {
    // Arrange
    const host = nodeLlmHost()
    const resolved = resolveLlmConfig(
      { provider: 'anthropic', model: null, maxCalls: 2, minConfidence: 0.8 },
      host.env,
    )
    if (!resolved.ok) throw new Error(resolved.error)
    const client = new LlmClient(resolved.config, host)
    const compiled = compile('fn add(a, b) {\n  a - b\n}\nprint(add(2, 3))\n')
    if (!compiled.ok) throw new Error('compile failed')
    const tree = callTree(record(compiled.program))
    const call = [...tree.calls({ justMyCode: true })].find((node) => node.name === 'add')!

    // Act
    const consultation = await new LlmOracle(client, tree, 0.8).consult(call)

    // Assert
    expect(consultation).toMatchObject({ kind: 'answer', auto: { answer: 'wrong' }, expected: '5' })
    expect(client.usage()).toMatch(/used 1 request/)
  }, 120_000)
})
