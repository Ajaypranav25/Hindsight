import { describe, expect, test } from 'vitest'
import { withInput } from './run-input'

const SOURCE =
  'let scores = [92, 88, 95]\nvar rate = 0.2\nfn f(x) { let local = 1\n x }\nprint(f(rate))\n'

describe('withInput', () => {
  test('replaces the initializer of a top-level let with a literal', () => {
    // Act
    const result = withInput(SOURCE, 'scores', ' [70, 80] ')

    // Assert
    expect(result).toEqual({
      ok: true,
      source: SOURCE.replace('[92, 88, 95]', '[70, 80]'),
      line: 1,
      was: '[92, 88, 95]',
      now: '[70, 80]',
    })
  })

  test('takes var bindings, negative numbers, strings, records and nil', () => {
    for (const value of ['-1.5', '"text"', '{a: 1, "b c": [true, nil]}', 'nil', 'false']) {
      const result = withInput(SOURCE, 'rate', value)
      expect(result).toMatchObject({ ok: true, line: 2, now: value })
    }
  })

  test('refuses names that are not top-level bindings, listing the ones there are', () => {
    expect(withInput(SOURCE, 'local', '1')).toEqual({
      ok: false,
      error: 'The program has no top-level let or var named local (it has scores, rate)',
    })
    expect(withInput('print(1)\n', 'x', '1')).toMatchObject({
      error: expect.stringContaining('it has none'),
    })
  })

  test('refuses values that are not literals, and programs that do not parse', () => {
    for (const value of [
      '',
      'rate + 1',
      '[...xs]',
      '{rate}',
      'not true',
      '[1, f(2)]',
      '1\n2',
      '(',
    ]) {
      expect(withInput(SOURCE, 'rate', value).ok).toBe(false)
    }
    expect(withInput('let = 1', 'x', '1')).toMatchObject({
      ok: false,
      error: expect.stringContaining('does not parse'),
    })
  })
})
