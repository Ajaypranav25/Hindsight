import { describe, expect, test } from 'vitest'
import {
  ANTHROPIC_VERSION,
  anthropicReply,
  DEFAULT_ANTHROPIC_MODEL,
  FALLBACK_BETA,
} from './anthropic'
import { LlmClient } from './client'
import { DEFAULT_TIMEOUT_MS, resolveLlmConfig } from './config'
import { anthropicText, fakeHost } from './fake-host'
import { MAX_RETRY_DELAY_MS, redact, RETRY_DELAY_MS } from './http'
import { extractJson } from './json'
import { openAiReply } from './openai'
import type { LlmArgs, LlmConfig, LlmRequest } from './types'

const ARGS: LlmArgs = { provider: null, model: null, maxCalls: 40, minConfidence: 0.8 }
const KEY = 'sk-ant-test-0123456789'
const REQUEST: LlmRequest = {
  system: 'You predict.',
  prompt: 'What does f(1) return?',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  effort: 'medium',
  maxTokens: 1000,
}

function anthropicConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'anthropic',
    model: DEFAULT_ANTHROPIC_MODEL,
    baseUrl: 'https://api.anthropic.com',
    apiKey: KEY,
    timeoutMs: 5_000,
    maxCalls: 40,
    ...overrides,
  }
}

function openAiConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'openai',
    model: 'qwen3:8b',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    timeoutMs: 5_000,
    maxCalls: 40,
    ...overrides,
  }
}

describe('resolveLlmConfig', () => {
  test('defaults to Anthropic with the default model and the key from the environment', () => {
    // Arrange
    const env = { ANTHROPIC_API_KEY: ` ${KEY} ` }

    // Act
    const result = resolveLlmConfig(ARGS, env)

    // Assert
    expect(result).toEqual({
      ok: true,
      config: {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: 'https://api.anthropic.com',
        apiKey: KEY,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxCalls: 40,
      },
    })
  })

  test('takes the model from the option first, then HINDSIGHT_LLM_MODEL', () => {
    const env = { ANTHROPIC_API_KEY: KEY, HINDSIGHT_LLM_MODEL: 'claude-sonnet-5-5' }
    expect(resolveLlmConfig(ARGS, env)).toMatchObject({ config: { model: 'claude-sonnet-5-5' } })
    expect(resolveLlmConfig({ ...ARGS, model: 'claude-haiku-5-5' }, env)).toMatchObject({
      config: { model: 'claude-haiku-5-5' },
    })
  })

  test('explains a missing Anthropic key without sending anything', () => {
    const result = resolveLlmConfig(ARGS, {})
    expect(result).toMatchObject({ ok: false })
    expect(!result.ok && result.error).toContain('ANTHROPIC_API_KEY')
  })

  test('chooses the OpenAI-compatible provider from the option or the environment', () => {
    const env = {
      HINDSIGHT_LLM_PROVIDER: 'openai',
      HINDSIGHT_LLM_BASE_URL: 'http://localhost:11434/v1/',
      HINDSIGHT_LLM_MODEL: 'qwen3:8b',
      HINDSIGHT_LLM_API_KEY: 'local-key',
    }
    expect(resolveLlmConfig(ARGS, env)).toMatchObject({
      ok: true,
      config: {
        provider: 'openai',
        model: 'qwen3:8b',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'local-key',
      },
    })
    const forced = resolveLlmConfig(
      { ...ARGS, provider: 'anthropic' },
      { ...env, ANTHROPIC_API_KEY: KEY },
    )
    expect(forced).toMatchObject({ config: { provider: 'anthropic' } })
  })

  test('requires a base URL and a model for the OpenAI-compatible provider', () => {
    const openai = { ...ARGS, provider: 'openai' as const }
    expect(resolveLlmConfig(openai, {})).toMatchObject({ ok: false })
    expect(resolveLlmConfig(openai, { HINDSIGHT_LLM_BASE_URL: 'ftp://x' })).toEqual({
      ok: false,
      error: 'HINDSIGHT_LLM_BASE_URL must be an http(s) URL',
    })
    const noModel = resolveLlmConfig(openai, { HINDSIGHT_LLM_BASE_URL: 'http://localhost:1/v1' })
    expect(!noModel.ok && noModel.error).toContain('--llm-model')
  })

  test('rejects an unknown provider, a bad base URL and a bad timeout', () => {
    expect(resolveLlmConfig(ARGS, { HINDSIGHT_LLM_PROVIDER: 'gemini' })).toMatchObject({
      ok: false,
    })
    expect(
      resolveLlmConfig(ARGS, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'not a url' }),
    ).toEqual({ ok: false, error: 'ANTHROPIC_BASE_URL must be an http(s) URL' })
    expect(
      resolveLlmConfig(ARGS, { ANTHROPIC_API_KEY: KEY, HINDSIGHT_LLM_TIMEOUT_MS: '5' }),
    ).toMatchObject({ ok: false })
    expect(
      resolveLlmConfig(ARGS, { ANTHROPIC_API_KEY: KEY, HINDSIGHT_LLM_TIMEOUT_MS: '9000' }),
    ).toMatchObject({ config: { timeoutMs: 9000 } })
  })
})

describe('the Anthropic provider', () => {
  test('sends a Messages API request with effort, structured output and fallbacks', async () => {
    // Arrange
    const host = fakeHost([anthropicText({ answer: 42 })])
    const client = new LlmClient(anthropicConfig(), host)

    // Act
    const result = await client.complete(REQUEST)

    // Assert
    expect(result).toEqual({
      ok: true,
      text: '{"answer":42}',
      usage: { input: 100, output: 20 },
    })
    const [sent] = host.sent
    expect(sent!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent!.headers).toMatchObject({
      'x-api-key': KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': FALLBACK_BETA,
    })
    expect(sent!.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      system: 'You predict.',
      messages: [{ role: 'user', content: 'What does f(1) return?' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: REQUEST.schema } },
      fallbacks: 'default',
    })
    expect(sent!.body).not.toHaveProperty('thinking')
    expect(sent!.body).not.toHaveProperty('temperature')
  })

  test('leaves out what an older or unknown model does not take', async () => {
    const host = fakeHost([anthropicText('{}')])
    await new LlmClient(anthropicConfig({ model: 'claude-3-custom' }), host).complete(REQUEST)
    const [sent] = host.sent
    expect(sent!.body).not.toHaveProperty('output_config')
    expect(sent!.body).not.toHaveProperty('fallbacks')
    expect(sent!.headers).not.toHaveProperty('anthropic-beta')
  })

  test('reads refusals, truncation and odd replies as errors', () => {
    expect(anthropicReply({ stop_reason: 'refusal', content: [] })).toMatchObject({ ok: false })
    expect(anthropicReply({ stop_reason: 'max_tokens', content: [] })).toEqual({
      ok: false,
      error: 'the answer was cut off at the token limit',
    })
    expect(anthropicReply(null)).toMatchObject({ ok: false })
    expect(anthropicReply({ content: 'text' })).toMatchObject({ ok: false })
    expect(anthropicReply({ content: [{ type: 'thinking', thinking: '' }] })).toEqual({
      ok: false,
      error: 'the reply has no text',
    })
  })

  test('counts cached input tokens with the rest', () => {
    const reply = anthropicReply({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 },
    })
    expect(reply).toEqual({ ok: true, text: 'hi', usage: { input: 12, output: 3 } })
  })
})

describe('the OpenAI-compatible provider', () => {
  test('posts chat completions with the schema in the system prompt and no key when none is set', async () => {
    // Arrange
    const host = fakeHost([
      {
        body: {
          choices: [{ message: { content: '```json\n{"a": 1}\n```' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 9 },
        },
      },
    ])
    const client = new LlmClient(openAiConfig(), host)

    // Act
    const reply = await client.completeJson(REQUEST)

    // Assert
    expect(reply).toEqual({ ok: true, json: { a: 1 } })
    const [sent] = host.sent
    expect(sent!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(sent!.headers).not.toHaveProperty('authorization')
    expect(sent!.body).toMatchObject({ model: 'qwen3:8b', temperature: 0, max_tokens: 1000 })
    const messages = sent!.body.messages as { role: string; content: string }[]
    expect(messages[0]!.content).toContain('JSON Schema')
    expect(client.usage()).toContain('50 input and 9 output tokens')
  })

  test('sends the key as a bearer token when one is set', async () => {
    const host = fakeHost([{ body: { choices: [{ message: { content: '{}' } }] } }])
    await new LlmClient(openAiConfig({ apiKey: 'local' }), host).complete(REQUEST)
    expect(host.sent[0]!.headers.authorization).toBe('Bearer local')
  })

  test('reads cut-off and empty replies as errors', () => {
    expect(
      openAiReply({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }),
    ).toEqual({ ok: false, error: 'the answer was cut off at the token limit' })
    expect(openAiReply({ choices: [] })).toMatchObject({ ok: false })
    expect(openAiReply({ choices: [{ message: { content: '' } }] })).toMatchObject({ ok: false })
    expect(openAiReply('nope')).toMatchObject({ ok: false })
  })
})

describe('errors, retries and the cap', () => {
  test('retries once after a 429, waiting as long as retry-after says', async () => {
    // Arrange
    const host = fakeHost([
      {
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'slow down' } },
        headers: { 'retry-after': '3' },
      },
      anthropicText('{}'),
    ])

    // Act
    const result = await new LlmClient(anthropicConfig(), host).complete(REQUEST)

    // Assert
    expect(result.ok).toBe(true)
    expect(host.sent).toHaveLength(2)
    expect(host.waits).toEqual([3000])
  })

  test('retries a 5xx once with the default delay, then reports both failures', async () => {
    const host = fakeHost([
      { status: 529, body: { error: { type: 'overloaded_error', message: 'busy' } } },
    ])
    const result = await new LlmClient(anthropicConfig(), host).complete(REQUEST)
    expect(result).toEqual({
      ok: false,
      error: 'HTTP 529 overloaded_error: busy (also on the retry)',
    })
    expect(host.sent).toHaveLength(2)
    expect(host.waits).toEqual([RETRY_DELAY_MS])
  })

  test('caps a long retry-after and never retries a spend-cap 429 or a 400', async () => {
    const capped = fakeHost([
      { status: 503, body: 'down', headers: { 'retry-after': '600' } },
      anthropicText('{}'),
    ])
    await new LlmClient(anthropicConfig(), capped).complete(REQUEST)
    expect(capped.waits).toEqual([MAX_RETRY_DELAY_MS])

    const spend = fakeHost([
      {
        status: 429,
        body: {
          error: {
            type: 'rate_limit_error',
            message: 'cap',
            details: { error_code: 'enforced_spend_limit_reached' },
          },
        },
      },
    ])
    expect((await new LlmClient(anthropicConfig(), spend).complete(REQUEST)).ok).toBe(false)
    expect(spend.sent).toHaveLength(1)

    const bad = fakeHost([{ status: 400, body: { error: 'bad schema' } }])
    expect(await new LlmClient(openAiConfig(), bad).complete(REQUEST)).toEqual({
      ok: false,
      error: 'HTTP 400: bad schema',
    })
  })

  test('never echoes the API key in an error message', async () => {
    const host = fakeHost([
      {
        status: 401,
        body: { error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } },
      },
    ])
    const result = await new LlmClient(anthropicConfig(), host).complete(REQUEST)
    expect(result.ok).toBe(false)
    const error = !result.ok ? result.error : ''
    expect(error).not.toContain(KEY)
    expect(error).toContain('***')
    expect(error).toContain('check the API key')
  })

  test('reports a timeout, an unreachable server, a missing fetch and a non-JSON reply', async () => {
    const slow = await new LlmClient(
      anthropicConfig({ timeoutMs: 20 }),
      fakeHost([{ hang: true, body: '' }]),
    ).complete(REQUEST)
    expect(!slow.ok && slow.error).toContain('no answer within')

    const failure = Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') })
    const down = await new LlmClient(
      openAiConfig(),
      fakeHost([{ fail: failure, body: '' }]),
    ).complete(REQUEST)
    expect(!down.ok && down.error).toBe(
      'could not reach localhost:11434: fetch failed (ECONNREFUSED)',
    )

    const noFetch = await new LlmClient(anthropicConfig(), { env: {}, fetch: undefined }).complete(
      REQUEST,
    )
    expect(!noFetch.ok && noFetch.error).toContain('no fetch')

    const garbled = await new LlmClient(
      anthropicConfig(),
      fakeHost([{ body: 'not json' }]),
    ).complete(REQUEST)
    expect(garbled).toEqual({ ok: false, error: 'the reply was not JSON' })
  })

  test('stops at the cap on requests and counts what was used', async () => {
    // Arrange
    const host = fakeHost([anthropicText('{"a": 1}')])
    const client = new LlmClient(anthropicConfig({ maxCalls: 1 }), host)

    // Act
    const first = await client.completeJson(REQUEST)
    const second = await client.completeJson(REQUEST)

    // Assert
    expect(first.ok).toBe(true)
    expect(second).toEqual({
      ok: false,
      error: 'the cap of 1 requests is reached (--llm-max-calls)',
    })
    expect(host.sent).toHaveLength(1)
    expect(client.exhausted).toBe(true)
    expect(client.usage()).toBe(
      'AI assistance used 1 request, 100 input and 20 output tokens (claude-opus-5-5).',
    )
    expect(client.notice()).toContain('Function source and the values of calls are sent')
  })

  test('reports an answer that is not JSON and counts failed requests', async () => {
    const client = new LlmClient(anthropicConfig(), fakeHost([anthropicText('I think it is 3.')]))
    expect(await client.completeJson(REQUEST)).toEqual({
      ok: false,
      error: 'the answer was not a JSON object',
    })
    const failing = new LlmClient(anthropicConfig(), fakeHost([{ status: 400, body: '{}' }]))
    await failing.complete(REQUEST)
    expect(failing.usage()).toContain('(1 failed)')
  })

  test('redacts every secret and shortens long messages', () => {
    expect(redact('a KEY b KEY', ['KEY'])).toBe('a *** b ***')
    expect(redact('x'.repeat(500), []).length).toBe(300)
  })
})

describe('extractJson', () => {
  test('reads plain, fenced and embedded JSON objects', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 })
    expect(extractJson('Here:\n```json\n{"b": 2}\n```')).toEqual({ b: 2 })
    expect(extractJson('The answer is {"c": 3}, I think.')).toEqual({ c: 3 })
  })

  test('returns null for anything else', () => {
    expect(extractJson('[1, 2]')).toBeNull()
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{broken')).toBeNull()
  })
})
