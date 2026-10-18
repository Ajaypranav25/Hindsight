import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { LIBRARY_NAMES } from './builtin-names'
import { PRELUDE_SOURCE } from './prelude'

function specAppendixSource(): string {
  const specPath = fileURLToPath(new URL('../../docs/SPEC.md', import.meta.url))
  const spec = readFileSync(specPath, 'utf8').replace(/\r\n/g, '\n')
  const appendix = spec.indexOf('## Appendix A')
  const open = '```hindsight\n'
  const start = spec.indexOf(open, appendix) + open.length
  const end = spec.indexOf('\n```', start)
  return spec.slice(start, end)
}

describe('prelude source', () => {
  test('matches docs/SPEC.md Appendix A exactly', () => {
    // Arrange
    const expected = specAppendixSource()

    // Act
    const actual = PRELUDE_SOURCE.replace(/\r\n/g, '\n').trimEnd()

    // Assert
    expect(actual).toBe(expected.trimEnd())
  })

  test('declares exactly the library functions, in builtin table order', () => {
    // Arrange
    const declared = [...PRELUDE_SOURCE.matchAll(/^fn ([a-z_]+)\(/gm)].map((m) => m[1])

    // Act / Assert
    expect(declared).toEqual([...LIBRARY_NAMES])
  })

  test('contains only top-level fn declarations', () => {
    // Arrange: every non-blank line at column 0 starts a declaration or closes one
    const topLevel = PRELUDE_SOURCE.split('\n').filter((line) => /^\S/.test(line))

    // Act / Assert
    for (const line of topLevel) expect(line).toMatch(/^(fn [a-z_]+\(.*\) \{|\})$/)
  })
})
