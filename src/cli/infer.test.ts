import { describe, expect, test } from 'vitest'
import { parseArgs } from './args'
import type { CliIO } from './io'
import { main } from './main'
import { McpServer } from './mcp'

interface FakeIO extends CliIO {
  readonly out: string[]
  readonly err: string[]
  readonly files: Record<string, string>
}

function fakeIO(files: Record<string, string>, writable = true): FakeIO {
  const out: string[] = []
  const err: string[] = []
  const io: FakeIO = {
    out,
    err,
    files,
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
  if (!writable) return io
  return {
    ...io,
    writeFile(path, text) {
      if (path === 'locked.sight') throw new Error('read-only')
      files[path] = text
    },
  }
}

function call(server: McpServer, name: string, args: object) {
  const reply = server.handle({
    jsonrpc: '2.0',
    id: 'i',
    method: 'tools/call',
    params: { name, arguments: args },
  }) as { result: { content: { text: string }[]; isError: boolean } }
  const text = reply.result.content[0]!.text
  return {
    isError: reply.result.isError,
    text,
    body: reply.result.isError ? null : JSON.parse(text),
  }
}

const TRUSTED = `fn add(a, b) { a + b }
fn average(xs) { sum(xs) / len(xs) }
fn once(x) { x }
print(add(1, 2), add(3, 4), add(10, 20))
print(average([1, 2, 3]), average([4]), average([2, 8]))
print(once(1))
`

describe('hindsight infer', () => {
  test('parses --fn and --write and rejects a bad function name', () => {
    // Arrange / Act
    const plain = parseArgs(['infer', 'a.sight'])
    const picked = parseArgs(['infer', 'a.sight', '--fn', 'add', '--write'])
    const bad = parseArgs(['infer', 'a.sight', '--fn', '1x'])

    // Assert
    expect(plain).toMatchObject({ ok: true, command: { kind: 'infer', fn: null, write: false } })
    expect(picked).toMatchObject({ ok: true, command: { fn: 'add', write: true } })
    expect(bad).toEqual({ ok: false, error: "--fn needs a function name, got '1x'" })
  })

  test('lists the checked clauses per function with an example call', () => {
    // Arrange
    const io = fakeIO({ 'a.sight': TRUSTED })

    // Act
    const code = main(['infer', 'a.sight'], io)

    // Assert
    const text = io.out.join('')
    expect(code).toBe(0)
    expect(text).toContain('add (line 1) · 3 calls, 3 different inputs')
    expect(text).toMatch(
      /ensures +result == a \+ b +3 inputs · e\.g\. add\(a = 1, b = 2\) returned 3/,
    )
    expect(text).toContain('requires len(xs) > 0')
    expect(text).toContain('once (line 3) · 1 call, 1 different input')
    expect(text).toContain('returned with 1 different input; at least 3 are needed')
    expect(text).toContain('checked: the program runs the same with these')
    expect(io.files['a.sight']).toBe(TRUSTED)
  })

  test('writes the clauses of the chosen function into the file with --write', () => {
    // Arrange
    const io = fakeIO({ 'a.sight': TRUSTED })

    // Act
    const code = main(['infer', 'a.sight', '--fn', 'add', '--write'], io)

    // Assert
    expect(code).toBe(0)
    expect(io.files['a.sight']).toContain(
      'fn add(a, b)\n  requires a > 0\n  requires b > 0\n  ensures result == a + b\n{ a + b }',
    )
    expect(io.files['a.sight']).toContain('fn average(xs) { sum(xs) / len(xs) }')
    expect(io.out.join('')).toContain('wrote 3 clauses into 1 function of a.sight')
  })

  test('says when there is nothing to write and when the file cannot be written', () => {
    // Arrange
    const nothing = fakeIO({ 'a.sight': TRUSTED })
    const locked = fakeIO({ 'locked.sight': TRUSTED })
    const readOnlyHost = fakeIO({ 'a.sight': TRUSTED }, false)

    // Act
    const none = main(['infer', 'a.sight', '--fn', 'once', '--write'], nothing)
    const failed = main(['infer', 'locked.sight', '--write'], locked)
    const noHost = main(['infer', 'a.sight', '--write'], readOnlyHost)

    // Assert
    expect(none).toBe(0)
    expect(nothing.out.join('')).toContain('nothing to write')
    expect(failed).toBe(1)
    expect(locked.err.join('')).toContain("cannot write 'locked.sight': read-only")
    expect(noHost).toBe(1)
    expect(readOnlyHost.err.join('')).toContain('cannot write files')
  })

  test('fails for an unknown function and a file that does not compile', () => {
    // Arrange
    const io = fakeIO({ 'a.sight': TRUSTED, 'bad.sight': 'let = 1' })

    // Act
    const unknown = main(['infer', 'a.sight', '--fn', 'nope'], io)
    const broken = main(['infer', 'bad.sight'], io)

    // Assert
    expect(unknown).toBe(1)
    expect(io.err.join('')).toContain("no function 'nope' declared with fn in a.sight")
    expect(broken).toBe(1)
  })

  test('says what the inference covers when the run did not finish', () => {
    // Arrange
    const io = fakeIO({ 'a.sight': `${TRUSTED}panic("stop")\n`, 'b.sight': 'print(1)\n' })

    // Act
    const code = main(['infer', 'a.sight'], io)
    main(['infer', 'b.sight'], io)

    // Assert
    expect(code).toBe(0)
    expect(io.out.join('')).toContain('runtime error (R')
    expect(io.out.join('')).toContain('inferred from the steps before it')
    expect(io.out.join('')).toContain('no functions declared with fn')
  })
})

describe('the infer_contracts MCP tool', () => {
  test('returns checked suggestions with their support for a source', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const { body } = call(server, 'infer_contracts', { source: TRUSTED })

    // Assert
    expect(body.verified).toBe(true)
    expect(body.functions_total).toBe(3)
    const add = body.functions.find((f: { function: string }) => f.function === 'add')
    expect(add.suggestions[0]).toMatchObject({
      kind: 'ensures',
      clause: 'result == a + b',
      pins_result: true,
      support: { calls: 3, inputs: 3 },
      example: 'add(a = 1, b = 2) returned 3',
    })
    expect(body.source_with_contracts).toBeUndefined()
  })

  test('narrows to one function on a trace and writes the clauses into the source on request', () => {
    // Arrange
    const server = new McpServer('0')
    const run = call(server, 'run_trace', { source: TRUSTED })

    // Act
    const { body } = call(server, 'infer_contracts', {
      trace_id: run.body.trace_id,
      function: 'average',
      max_per_function: 1,
      include_source: true,
    })

    // Assert
    expect(body.functions.map((f: { function: string }) => f.function)).toEqual(['average'])
    expect(body.functions[0].suggestions).toHaveLength(1)
    expect(body.source_with_contracts).toContain('fn average(xs)\n  requires')
  })

  test('reports an unknown function as a tool error', () => {
    // Arrange
    const server = new McpServer('0')

    // Act
    const reply = call(server, 'infer_contracts', { source: TRUSTED, function: 'nope' })

    // Assert
    expect(reply.isError).toBe(true)
    expect(reply.text).toContain("no function 'nope'")
  })
})
