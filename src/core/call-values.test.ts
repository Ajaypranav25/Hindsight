import { describe, expect, test } from 'vitest'
import type { Recording, ValueView } from './api-types'
import {
  cutText,
  deepText,
  KEY_TEXT_LIMIT,
  keyText,
  STRING_TEXT_LIMIT,
  valueText,
} from './call-values'
import { compile, record } from './index'

/** Records `source` and returns the recording with a lookup for its globals at the end. */
function finished(source: string): { recording: Recording; value: (name: string) => ValueView } {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
  const recording = record(compiled.program)
  const globals = recording.stateAt(recording.length).globals
  return {
    recording,
    value: (name) => {
      const found = globals.find((global) => global.name === name)
      if (!found) throw new Error(`no global ${name}`)
      return found.value
    },
  }
}

describe('valueText', () => {
  test('shows primitives in repr form and objects by their preview', () => {
    expect(valueText({ kind: 'nil' })).toBe('nil')
    expect(valueText({ kind: 'bool', value: true })).toBe('true')
    expect(valueText({ kind: 'bool', value: false })).toBe('false')
    expect(valueText({ kind: 'number', value: -2.5 })).toBe('-2.5')
    expect(valueText({ kind: 'string', value: 'hi' })).toBe('"hi"')
    const preview = '[1, 2]'
    expect(valueText({ kind: 'ref', id: 7, type: 'list', preview })).toBe(preview)
  })

  test('cuts long strings to the question limit', () => {
    const text = valueText({ kind: 'string', value: 'x'.repeat(STRING_TEXT_LIMIT * 2) })
    expect(text.length).toBeLessThanOrEqual(STRING_TEXT_LIMIT)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('cutText', () => {
  test('keeps short text and ends cut text with an ellipsis', () => {
    expect(cutText('abc', 5)).toBe('abc')
    expect(cutText('abcdef', 4)).toBe('abc…')
  })
})

describe('deepText', () => {
  test('renders nested lists and records like repr in both modes', () => {
    const { recording, value } = finished('let v = [1, [2, "x"], {a: true, "b c": nil}]\n')
    for (const mode of ['key', 'display'] as const) {
      const text = deepText(recording, recording.length, value('v'), mode, 1000)
      expect(text).toEqual({ text: '[1, [2, "x"], {a: true, "b c": nil}]', complete: true })
    }
  })

  test('pages through lists and records longer than one page', () => {
    const { recording, value } = finished(
      'let xs = list(0..250)\nvar r = {}\nfor i in 0..150 { r["k{i}"] = i }\n',
    )
    const list = deepText(recording, recording.length, value('xs'), 'key', 100_000)
    expect(list?.complete).toBe(true)
    expect(list?.text.startsWith('[0, 1, 2')).toBe(true)
    expect(list?.text.endsWith('248, 249]')).toBe(true)
    const rec = deepText(recording, recording.length, value('r'), 'key', 100_000)
    expect(rec?.complete).toBe(true)
    expect(rec?.text).toContain('k0: 0')
    expect(rec?.text.endsWith('k149: 149}')).toBe(true)
  })

  test('stops at the limit and says the text is incomplete', () => {
    const { recording, value } = finished('let xs = list(0..1000)\nlet s = repeat("ab", 500)\n')
    const list = deepText(recording, recording.length, value('xs'), 'display', 20)
    expect(list?.complete).toBe(false)
    expect(list!.text.length).toBeLessThan(40)
    const string = deepText(recording, recording.length, value('s'), 'display', 10)
    expect(string?.complete).toBe(false)
  })

  test('cycles: key mode refuses to compare them, display mode marks them', () => {
    const { recording, value } = finished('let a = [1]\npush(a, a)\nlet r = {}\nr.me = r\n')
    expect(deepText(recording, recording.length, value('a'), 'key', 1000)).toBeNull()
    expect(deepText(recording, recording.length, value('a'), 'display', 1000)?.text).toBe(
      '[1, [...]]',
    )
    expect(deepText(recording, recording.length, value('r'), 'display', 1000)?.text).toBe(
      '{me: {...}}',
    )
  })

  test('functions are identified by proto and captures in key mode, previewed in display mode', () => {
    const { recording, value } = finished('let k = 5\nfn make() { |x| x + k }\nlet f = make()\n')
    const key = deepText(recording, recording.length, value('f'), 'key', 1000)
    expect(key?.text).toMatch(/^<fn#\d+ .*>\(\)$|^<fn#\d+ .*>\(k=5\)$/)
    const display = deepText(recording, recording.length, value('f'), 'display', 1000)
    expect(display?.text).toBe((value('f') as ValueView & { kind: 'ref' }).preview)
  })

  test('captured variables are part of a function key', () => {
    const { recording, value } = finished(
      'fn adder(n) { |x| x + n }\nlet one = adder(1)\nlet two = adder(2)\n',
    )
    const one = keyText(recording, recording.length, value('one'))
    const two = keyText(recording, recording.length, value('two'))
    expect(one).toContain('n=1')
    expect(two).toContain('n=2')
    expect(one).not.toBe(two)
  })

  test('builtins and ranges have stable texts', () => {
    const { recording, value } = finished(
      'let p = print\nlet r = range(0, 10, 2)\nlet q = 1..=3\nlet s = 0..5\n',
    )
    const key = (name: string) => keyText(recording, recording.length, value(name))
    expect(key('p')).toBe('<builtin print>')
    expect(key('r')).toBe('range(0, 10, 2)')
    expect(key('q')).toBe('1..=3')
    expect(key('s')).toBe('0..5')
  })

  test('nesting deeper than the renderer allows is not compared', () => {
    const { recording, value } = finished('var v = 0\nfor i in 0..40 { v = [v] }\n')
    expect(deepText(recording, recording.length, value('v'), 'key', 100_000)).toBeNull()
  })

  test('an object that does not exist at that time cannot be rendered', () => {
    const { recording } = finished('let xs = [1, 2]\n')
    const ghost: ValueView = { kind: 'ref', id: 987_654, type: 'list', preview: '[]' }
    expect(deepText(recording, recording.length, ghost, 'key', 1000)).toBeNull()
  })
})

describe('keyText', () => {
  test('gives the full text, or null when it would be longer than the key limit', () => {
    const { recording, value } = finished(
      `let small = [1, 2]\nlet big = [repeat("z", ${KEY_TEXT_LIMIT})]\n`,
    )
    expect(keyText(recording, recording.length, value('small'))).toBe('[1, 2]')
    expect(keyText(recording, recording.length, value('big'))).toBeNull()
  })
})
