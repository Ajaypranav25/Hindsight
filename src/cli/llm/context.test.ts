import { describe, expect, test } from 'vitest'
import { type CallTree, callTree, compile, record } from '../../core/index'
import {
  callWithArguments,
  functionSource,
  helperSources,
  MAX_FUNCTION_TEXT,
  MAX_HELPERS,
  resultText,
} from './context'
import { unifiedDiff } from './line-diff'

function treeOf(source: string): CallTree {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.diagnostics)}`)
  return callTree(record(compiled.program))
}

function named(tree: CallTree, name: string) {
  return [...tree.calls({ justMyCode: true })].find((call) => call.name === name)!
}

describe('functionSource', () => {
  test('takes the block comment above a function as its documentation, and stops at code', () => {
    // Arrange
    const tree = treeOf(
      'let x = 1\n/* Doubles n.\n * Always.\n */\nfn double(n) { n * 2 }\nprint(double(x))\n',
    )

    // Act
    const text = functionSource(tree.recording, named(tree, 'double').protoId)

    // Assert
    expect(text).toBe('/* Doubles n.\n * Always.\n */\nfn double(n) { n * 2 }')
  })

  test('cuts a very long function and has nothing for the top-level code', () => {
    // Arrange
    const body = Array.from({ length: 900 }, (_, i) => `  let v${i} = ${i}`).join('\n')
    const tree = treeOf(`fn long() {\n${body}\n  1\n}\nprint(long())\n`)

    // Act
    const text = functionSource(tree.recording, named(tree, 'long').protoId)!
    const root = functionSource(tree.recording, tree.root.protoId)

    // Assert
    expect(text.length).toBe(MAX_FUNCTION_TEXT + '\n// … cut'.length)
    expect(text.endsWith('// … cut')).toBe(true)
    expect(root).toBeNull()
  })
})

describe('helperSources', () => {
  test('lists each user function the call made once, not itself, not library code, at most six', () => {
    // Arrange
    const helpers = Array.from({ length: 8 }, (_, i) => `fn h${i}(x) { x + ${i} }`).join('\n')
    const calls = Array.from({ length: 8 }, (_, i) => `h${i}(n)`).join(' + ')
    const tree = treeOf(
      `${helpers}\nfn all(n) {\n  if n > 0 { all(n - 1) }\n  [1] |> map(|v| v) |> len()\n  ${calls} + h0(n)\n}\nprint(all(1))\n`,
    )

    // Act
    const shown = helperSources(tree, named(tree, 'all'))

    // Assert
    expect(shown).toHaveLength(MAX_HELPERS)
    expect(shown[0]).toBe('fn h0(x) { x + 0 }')
    expect(shown.some((text) => text.startsWith('fn all'))).toBe(false)
  })

  test('shows calls with full argument values and results as Hindsight text', () => {
    // Arrange
    const tree = treeOf('fn pick(r, k) { r[k] }\nprint(pick({a: [1, "x"]}, "a"))\n')
    const details = tree.details(named(tree, 'pick'))

    // Act
    const call = callWithArguments(tree.recording, details)
    const result = resultText(tree.recording, details)

    // Assert
    expect(call).toBe('pick(r = {a: [1, "x"]}, k = "a")')
    expect(result).toBe('[1, "x"]')
  })
})

describe('unifiedDiff alignment', () => {
  test('an insertion before a kept line and removals after it', () => {
    // Arrange, Act
    const diff = unifiedDiff('x\na\nc\nq\ny', 'x\nb\na\nd\ny')

    // Assert
    expect(diff).toEqual(['@@ -1,5 +1,5 @@', ' x', '+b', ' a', '-c', '-q', '+d', ' y'])
  })
})
