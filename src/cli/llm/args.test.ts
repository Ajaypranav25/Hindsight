import { describe, expect, test } from 'vitest'
import { parseArgs, USAGE } from '../args'
import { llmArgs } from './args'

describe('the --llm options', () => {
  test('are off unless --llm is given, and refinements without it are usage errors', () => {
    // Arrange, Act, Assert
    expect(llmArgs(new Map())).toBeNull()
    expect(llmArgs(new Map([['--llm-model', 'x']]))).toBe("option '--llm-model' needs --llm")
    expect(parseArgs(['debug', 'a.sight', '--llm-min-confidence', '0.5'])).toEqual({
      ok: false,
      error: "option '--llm-min-confidence' needs --llm",
    })
  })

  test('debug takes --llm alone or with a provider, a model, a cap and a confidence', () => {
    // Arrange, Act
    const plain = parseArgs(['debug', 'a.sight', '--llm'])
    const full = parseArgs([
      'debug',
      'a.sight',
      '--llm=openai',
      '--llm-model',
      'qwen3:8b',
      '--llm-max-calls=5',
      '--llm-min-confidence=0.9',
    ])

    // Assert
    expect(plain).toMatchObject({
      ok: true,
      command: { llm: { provider: null, model: null, maxCalls: 40, minConfidence: 0.8 } },
    })
    expect(full).toMatchObject({
      ok: true,
      command: { llm: { provider: 'openai', model: 'qwen3:8b', maxCalls: 5, minConfidence: 0.9 } },
    })
  })

  test('rejects an unknown provider, a bad cap, a bad confidence and an empty model', () => {
    // Arrange
    const cases = [
      ['--llm=gpt'],
      ['--llm', '--llm-max-calls=0'],
      ['--llm', '--llm-max-calls=2.5'],
      ['--llm', '--llm-min-confidence=1.5'],
      ['--llm', '--llm-min-confidence=high'],
      ['--llm', '--llm-model= '],
    ]

    // Act
    const errors = cases.map((flags) => {
      const parsed = parseArgs(['debug', 'a.sight', ...flags])
      return parsed.ok ? 'ok' : parsed.error
    })

    // Assert
    expect(errors).toEqual([
      "--llm takes no value or one of: anthropic, openai (got 'gpt')",
      "option '--llm-max-calls' must be an integer >= 1, got '0'",
      "option '--llm-max-calls' must be an integer >= 1, got '2.5'",
      "option '--llm-min-confidence' must be a number from 0 to 1, got '1.5'",
      "option '--llm-min-confidence' must be a number from 0 to 1, got 'high'",
      'option --llm-model needs a model name',
    ])
  })

  test('repair takes --llm and --apply N; --apply needs --llm; other commands take neither', () => {
    // Arrange, Act
    const plain = parseArgs(['repair', 'a.sight'])
    const applied = parseArgs(['repair', 'a.sight', '--llm', '--apply', '2'])
    const stray = parseArgs(['repair', 'a.sight', '--apply', '1'])
    const zero = parseArgs(['repair', 'a.sight', '--llm', '--apply=0'])
    const confidence = parseArgs(['repair', 'a.sight', '--llm', '--llm-min-confidence=0.5'])
    const run = parseArgs(['run', 'a.sight', '--llm'])

    // Assert
    expect(plain).toMatchObject({ ok: true, command: { llm: null, apply: null } })
    expect(applied).toMatchObject({ ok: true, command: { llm: { maxCalls: 40 }, apply: 2 } })
    expect(stray).toEqual({ ok: false, error: "option '--apply' needs --llm" })
    expect(zero).toMatchObject({ ok: false })
    expect(confidence).toEqual({
      ok: false,
      error: "option '--llm-min-confidence' does not apply to 'repair'",
    })
    expect(run).toEqual({ ok: false, error: "option '--llm' does not apply to 'run'" })
    expect(USAGE).toContain('[--llm[=anthropic|openai]]')
  })
})
