import { describe, expect, test } from 'vitest'
import { parseAnnotation, parseAnnotations, splitAnnotations } from './annotations'

describe('splitAnnotations', () => {
  test('returns nothing for a line without annotations', () => {
    expect(splitAnnotations('print(1) // a comment')).toEqual([])
  })

  test('starts an annotation at each occurrence of the marker', () => {
    // Arrange
    const line = 'print("a\\nb") // expect: a // expect: b'

    // Act
    const parts = splitAnnotations(line)

    // Assert
    expect(parts).toEqual(['// expect: a ', '// expect: b'])
  })

  test('requires the exact marker text', () => {
    expect(splitAnnotations('x //expect: 1 / / expect: 2')).toEqual([])
  })
})

describe('parseAnnotation: output form', () => {
  test('reads the text after "// expect: "', () => {
    expect(parseAnnotation('// expect: hello world', 3)).toEqual({
      kind: 'output',
      line: 3,
      text: 'hello world',
    })
  })

  test('a bare "// expect:" expects an empty line', () => {
    expect(parseAnnotation('// expect:', 1)).toEqual({ kind: 'output', line: 1, text: '' })
  })

  test('removes trailing whitespace but keeps leading spaces after the separator', () => {
    expect(parseAnnotation('// expect:   indented  \t', 2)).toEqual({
      kind: 'output',
      line: 2,
      text: '  indented',
    })
  })

  test('whitespace-only text is an empty line', () => {
    expect(parseAnnotation('// expect:    ', 2)).toEqual({ kind: 'output', line: 2, text: '' })
  })

  test('text without the separating space is malformed', () => {
    expect(parseAnnotation('// expect:x', 4)).toEqual({
      kind: 'malformed',
      line: 4,
      raw: '// expect:x',
    })
  })
})

describe('parseAnnotation: error forms', () => {
  test('compile error with nothing else', () => {
    expect(parseAnnotation('// expect compile error', 1)).toEqual({
      kind: 'compile-error',
      line: 1,
      code: null,
      text: null,
      hint: null,
    })
  })

  test('compile error with a code', () => {
    expect(parseAnnotation('// expect compile error E020', 1)).toMatchObject({
      kind: 'compile-error',
      code: 'E020',
      text: null,
      hint: null,
    })
  })

  test('compile error with a code, text and hint', () => {
    // Arrange
    const raw =
      "// expect compile error E020: undefined variable 'prnt' // hint: did you mean 'print'?"

    // Act
    const annotation = parseAnnotation(raw, 7)

    // Assert
    expect(annotation).toEqual({
      kind: 'compile-error',
      line: 7,
      code: 'E020',
      text: "undefined variable 'prnt'",
      hint: "did you mean 'print'?",
    })
  })

  test('text without a code', () => {
    expect(parseAnnotation('// expect compile error: invalid pattern', 1)).toMatchObject({
      code: null,
      text: 'invalid pattern',
      hint: null,
    })
  })

  test('a hint without text', () => {
    expect(
      parseAnnotation('// expect compile error E026 // hint: hides the builtin', 1),
    ).toMatchObject({ code: 'E026', text: null, hint: 'hides the builtin' })
  })

  test('a hint without code or text', () => {
    expect(parseAnnotation('// expect runtime error // hint: convert with str()', 1)).toMatchObject(
      {
        kind: 'runtime-error',
        code: null,
        text: null,
        hint: 'convert with str()',
      },
    )
  })

  test('a colon with empty text matches any message', () => {
    expect(parseAnnotation('// expect runtime error R001:   ', 1)).toMatchObject({
      code: 'R001',
      text: '',
      hint: null,
    })
  })

  test('an empty hint requires some hint', () => {
    expect(parseAnnotation('// expect runtime error R001 // hint:', 1)).toMatchObject({
      code: 'R001',
      hint: '',
    })
  })

  test('runtime error with code and text', () => {
    expect(parseAnnotation('// expect runtime error R002: division by zero', 9)).toEqual({
      kind: 'runtime-error',
      line: 9,
      code: 'R002',
      text: 'division by zero',
      hint: null,
    })
  })

  test('text keeps inner spacing and loses trailing whitespace', () => {
    expect(parseAnnotation('// expect runtime error: a  b   ', 1)).toMatchObject({ text: 'a  b' })
  })

  test('text runs up to the first hint separator', () => {
    expect(parseAnnotation('// expect runtime error: x // hint: y // hint: z', 1)).toMatchObject({
      text: 'x',
      hint: 'y // hint: z',
    })
  })

  test.each([
    ['// expect compile error R001', 'a runtime code in a compile annotation'],
    ['// expect runtime error E001', 'a compile code in a runtime annotation'],
    ['// expect compile error E01', 'a short code'],
    ['// expect compile error E0201', 'a long code'],
    ['// expect compile error e020', 'a lowercase code'],
    ['// expect compile errors', 'a misspelled form'],
    ['// expect compile error E020:message', 'text without the separating space'],
    ['// expect compile error E020 message', 'text without a colon'],
    ['// expect compile error E020 // hint', 'a hint without a colon'],
    ['// expect compile error // hint:x', 'a hint without the separating space'],
    ['// expect runtime', 'an incomplete form'],
    ['// expected: 1', 'a different word'],
    ['// expect', 'the marker alone'],
    ['// expect output: 1', 'an unknown form'],
  ])('%s is malformed (%s)', (raw) => {
    expect(parseAnnotation(raw, 5)).toEqual({ kind: 'malformed', line: 5, raw })
  })
})

describe('parseAnnotations', () => {
  test('returns annotations in file order with 1-based lines', () => {
    // Arrange
    const source = [
      'print(1) // expect: 1',
      'let x = 2',
      'print(x, x) // expect: 2 2',
      'x() // expect runtime error R004: cannot call a number',
    ].join('\n')

    // Act
    const annotations = parseAnnotations(source)

    // Assert
    expect(annotations).toEqual([
      { kind: 'output', line: 1, text: '1' },
      { kind: 'output', line: 3, text: '2 2' },
      {
        kind: 'runtime-error',
        line: 4,
        code: 'R004',
        text: 'cannot call a number',
        hint: null,
      },
    ])
  })

  test('splits lines at \\n, \\r\\n and \\r like LineIndex', () => {
    // Arrange
    const source = 'a // expect: 1\r\nb // expect: 2\rc\nd // expect: 4'

    // Act
    const lines = parseAnnotations(source).map((annotation) => annotation.line)

    // Assert
    expect(lines).toEqual([1, 2, 4])
  })

  test('scans without regard to lexical context', () => {
    // Arrange
    const source = 'let s = "abc // expect compile error E002: unterminated string'

    // Act
    const annotations = parseAnnotations(source)

    // Assert
    expect(annotations).toEqual([
      { kind: 'compile-error', line: 1, code: 'E002', text: 'unterminated string', hint: null },
    ])
  })

  test('reports several annotations on one line separately', () => {
    // Arrange
    const source = 'print("a\\nb") // expect: a // expect: b'

    // Act
    const texts = parseAnnotations(source).map((annotation) =>
      annotation.kind === 'output' ? annotation.text : annotation.kind,
    )

    // Assert
    expect(texts).toEqual(['a', 'b'])
  })

  test('keeps malformed annotations with their line', () => {
    expect(parseAnnotations('x\ny // expect compile eror')).toEqual([
      { kind: 'malformed', line: 2, raw: '// expect compile eror' },
    ])
  })

  test('returns nothing for a file without annotations', () => {
    expect(parseAnnotations('')).toEqual([])
    expect(parseAnnotations('print(1)\n// just a comment\n')).toEqual([])
  })
})
