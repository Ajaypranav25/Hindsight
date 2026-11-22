import { describe, expect, test } from 'vitest'
import { parseArgs } from './args'
import type { CliIO } from './io'
import { main } from './main'
import { McpServer } from './mcp'
import { outcomeNote, percent } from './profile'

interface FakeIO extends CliIO {
  readonly out: string[]
  readonly err: string[]
}

function fakeIO(files: Record<string, string>): FakeIO {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    color: false,
    readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error('no such file')
      return content
    },
    listFiles: () => [],
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
}

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'p',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  return { isError: reply.result.isError, body: JSON.parse(reply.result.content[0]!.text) }
}

const HOT = `fn slow(n) {
  var total = 0
  for i in 0..n {
    total += i
  }
  total
}
fn fast(n) { n * 2 }
print(slow(50) + fast(3))
print(map([1, 2], |x| fast(x)))
`

describe('hindsight profile', () => {
  test('parses its options and rejects folded stacks with tables', () => {
    // Arrange / Act
    const plain = parseArgs(['profile', 'a.sight'])
    const folded = parseArgs(['profile', 'a.sight', '--folded', '--lines'])
    const top = parseArgs(['profile', 'a.sight', '--top', '0'])

    // Assert
    expect(plain).toMatchObject({ ok: true, command: { kind: 'profile', top: 15, lines: false } })
    expect(folded).toMatchObject({ ok: false })
    expect(top).toMatchObject({ ok: false })
  })

  test('lists functions by inclusive steps, then the hot lines', () => {
    // Arrange
    const io = fakeIO({ 'hot.sight': HOT })

    // Act
    const code = main(['profile', 'hot.sight', '--lines', '--top', '3'], io)
    const text = io.out.join('')

    // Assert
    expect(code).toBe(0)
    const rows = text.split('\n')
    expect(rows[0]).toMatch(/^[\d,]+ steps · 4 functions/)
    expect(rows.findIndex((row) => row.includes('<top level>'))).toBeLessThan(
      rows.findIndex((row) => row.includes('slow (line 1)')),
    )
    expect(text).toContain('… 1 more (raise --top)')
    expect(text).toMatch(/\| total \+= i/)
    expect(text).toContain('more lines (raise --top)')
  })

  test('prints folded stacks for flame graph tools', () => {
    // Arrange
    const io = fakeIO({ 'hot.sight': HOT })

    // Act
    const code = main(['profile', 'hot.sight', '--folded'], io)
    const lines = io.out.join('').trim().split('\n')

    // Assert
    expect(code).toBe(0)
    expect(lines).toContain(lines.find((line) => /^<top level>;slow \d+$/.test(line)))
    expect(lines.some((line) => /^<top level>;lambda@10;fast \d+$/.test(line))).toBe(true)
  })

  test('notes a run that did not finish and still profiles it', () => {
    // Arrange
    const io = fakeIO({ 'crash.sight': 'fn f(x) { x / 0 }\nprint(f(1))\n', 'bad.sight': 'let = 1' })

    // Act
    const code = main(['profile', 'crash.sight'], io)
    const bad = main(['profile', 'bad.sight'], io)

    // Assert
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('runtime error (R002)')
    expect(bad).toBe(1)
  })

  test('describes outcomes and shares', () => {
    // Arrange / Act / Assert
    expect(percent(1, 3)).toBe('33.3 %')
    expect(percent(0, 0)).toBe('0.0 %')
    expect(outcomeNote({ kind: 'finished' })).toBeNull()
    expect(outcomeNote({ kind: 'step-limit', maxSteps: 1000 })).toContain('1,000')
    expect(outcomeNote({ kind: 'aborted' })).toContain('stopped early')
  })
})

describe('the profile MCP tool', () => {
  test('returns the top functions and lines within the limit', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const result = call(server, 'profile', { source: HOT, top: 2 })

    // Assert
    expect(result.isError).toBe(false)
    expect(result.body.functions).toHaveLength(2)
    expect(result.body.functions_total).toBe(4)
    expect(result.body.functions[1]).toMatchObject({ function: 'slow', line: 1, calls: 1 })
    expect(result.body.lines[0]).toMatchObject({
      text: expect.any(String),
      share: expect.any(Number),
    })
    expect(result.body.folded).toBeUndefined()
  })

  test('lists folded stacks and library functions on request', () => {
    // Arrange
    const server = new McpServer('0')
    const run = call(server, 'run_trace', { source: HOT })

    // Act
    const result = call(server, 'profile', {
      trace_id: run.body.trace_id,
      just_my_code: false,
      folded: true,
    })

    // Assert
    expect(result.body.just_my_code).toBe(false)
    expect(result.body.functions.some((fn: { library: boolean }) => fn.library)).toBe(true)
    expect(result.body.folded[0]).toMatch(/ \d+$/)
    expect(result.body.folded_total).toBeGreaterThan(3)
  })

  test('reports a missing program as a tool error', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const result = call(server, 'profile', {})

    // Assert
    expect(result.isError).toBe(true)
  })
})
