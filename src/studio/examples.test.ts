import { describe, expect, test } from 'vitest'
import { EXAMPLES, parseExample } from './examples'

describe('examples', () => {
  test('parses header comments into gallery entries', () => {
    const source = '// title: Bug hunt\n// summary: Find it.\n// outcome: error\nprint(1)\n'
    expect(parseExample('/examples/02-bug-hunt.sight', source)).toEqual({
      id: 'bug-hunt',
      title: 'Bug hunt',
      summary: 'Find it.',
      source,
      outcome: 'error',
    })
  })

  test('falls back to the file name when headers are missing', () => {
    const example = parseExample('/examples/x.sight', 'print(1)')
    expect(example).toMatchObject({ id: 'x', title: 'x', summary: '', outcome: 'finished' })
  })

  test('loads the gallery in file order with titles and summaries', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(12)
    expect(EXAMPLES[0]!.id).toBe('hello')
    for (const example of EXAMPLES) {
      expect(example.title.length).toBeGreaterThan(0)
      expect(example.summary.length).toBeGreaterThan(20)
    }
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length)
  })
})
