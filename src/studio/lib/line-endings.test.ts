import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { lineEndingOf, normalizeLineEndings, withLineEnding } from './line-endings'

describe('line endings', () => {
  test('normalizes CRLF and lone CR to LF, leaving LF text untouched', () => {
    expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
    const plain = 'let x = 1\nprint(x)\n'
    expect(normalizeLineEndings(plain)).toBe(plain)
  })

  test('a file uses the line ending of its first line break', () => {
    expect(lineEndingOf('a\r\nb\n')).toBe('\r\n')
    expect(lineEndingOf('a\nb\r\n')).toBe('\n')
    expect(lineEndingOf('a\rb')).toBe('\n')
    expect(lineEndingOf('no breaks')).toBe('\n')
    expect(lineEndingOf('')).toBe('\n')
  })

  test('writes normalized text back with the requested line ending', () => {
    expect(withLineEnding('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(withLineEnding('a\r\nb\n', '\r\n')).toBe('a\r\nb\r\n')
    expect(withLineEnding('a\r\nb', '\n')).toBe('a\nb')
  })

  test('a CRLF file survives being read and written back', () => {
    fc.assert(
      fc.property(fc.array(fc.string().map((line) => line.replace(/[\r\n]/g, ''))), (lines) => {
        // Arrange
        const file = lines.join('\r\n')

        // Act
        const normal = normalizeLineEndings(file)
        const written = withLineEnding(normal, '\r\n')

        // Assert
        expect(normal.includes('\r')).toBe(false)
        expect(written).toBe(file)
      }),
    )
  })
})
