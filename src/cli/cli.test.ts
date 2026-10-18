import { describe, expect, test } from 'vitest'
import type { CliIO } from './io'
import { codeFrame, formatDiagnostic, makeStyle } from './format'
import { main } from './main'
import { ReplSession } from './repl'

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
    listFiles(dir, extension) {
      const prefix = `${dir}/`
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix) && path.endsWith(extension))
        .map((path) => path.slice(prefix.length))
        .sort()
    },
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  }
}

const FIB = `fn fib(n) {
  if n < 2 { return n }
  fib(n - 1) + fib(n - 2)
}
var total = 0
for i in 0..6 {
  total += fib(i)
}
print("total {total}")
`

describe('hindsight run', () => {
  test('prints program output and exits 0', () => {
    const io = fakeIO({ 'fib.sight': FIB })
    expect(main(['run', 'fib.sight'], io)).toBe(0)
    expect(io.out.join('')).toBe('total 12\n')
  })

  test('reports runtime errors with a code frame and stack', () => {
    const io = fakeIO({ 'crash.sight': 'let xs = [1, 2]\nprint(xs[5])\n' })
    expect(main(['run', 'crash.sight'], io)).toBe(1)
    const err = io.err.join('')
    expect(err).toContain('runtime error[R007]: index 5 is out of bounds for a list of length 2')
    expect(err).toContain('--> crash.sight:2:7')
    expect(err).toContain('^^^^^')
    expect(err).toContain('at <top level>')
  })

  test('stops at the step limit with exit code 2', () => {
    const io = fakeIO({ 'spin.sight': 'while true { }\n' })
    expect(main(['run', 'spin.sight', '--max-steps', '1000'], io)).toBe(2)
    expect(io.err.join('')).toContain('step limit')
  })

  test('reports unreadable files', () => {
    const io = fakeIO({})
    expect(main(['run', 'missing.sight'], io)).toBe(1)
    expect(io.err.join('')).toContain("cannot read 'missing.sight'")
  })
})

describe('hindsight check and disasm', () => {
  test('check prints diagnostics with hints', () => {
    const io = fakeIO({ 'typo.sight': 'let length = 3\nprint(lenght)\n' })
    expect(main(['check', 'typo.sight'], io)).toBe(1)
    const err = io.err.join('')
    expect(err).toContain("error[E020]: undefined variable 'lenght'")
    expect(err).toContain("= hint: did you mean 'length'?")
    expect(err).toContain('1 error in typo.sight')
  })

  test('check accepts a valid program', () => {
    const io = fakeIO({ 'ok.sight': 'print(1)\n' })
    expect(main(['check', 'ok.sight'], io)).toBe(0)
  })

  test('disasm prints bytecode', () => {
    const io = fakeIO({ 'ok.sight': 'print(1 + 2)\n' })
    expect(main(['disasm', 'ok.sight'], io)).toBe(0)
    expect(io.out.join('')).toMatch(/Add/)
  })
})

describe('hindsight replay and why', () => {
  test('replay shows frames, locals and output at a step', () => {
    const io = fakeIO({ 'fib.sight': FIB })
    expect(main(['replay', 'fib.sight', '--at', '60'], io)).toBe(0)
    const out = io.out.join('')
    expect(out).toContain('step 60 of')
    expect(out).toContain('frames (innermost first):')
  })

  test('replay past the end shows the finished program', () => {
    const io = fakeIO({ 'fib.sight': FIB })
    expect(main(['replay', 'fib.sight', '--at', '999999'], io)).toBe(0)
    const out = io.out.join('')
    expect(out).toContain('the program has finished')
    expect(out).toContain('total = 12')
    expect(out).toContain('total 12')
  })

  test('why lists every change to a global', () => {
    const io = fakeIO({ 'fib.sight': FIB })
    expect(main(['why', 'fib.sight', '--line', '5', '--name', 'total'], io)).toBe(0)
    const out = io.out.join('')
    expect(out).toContain("history of 'total'")
    expect(out).toMatch(/declare\s+total = 0/)
    expect(out).toMatch(/write\s+total = 12/)
  })

  test('why finds locals inside functions', () => {
    const source =
      'fn sum(xs) {\n  var acc = 0\n  for x in xs { acc += x }\n  acc\n}\nprint(sum([1, 2, 3]))\n'
    const io = fakeIO({ 's.sight': source })
    expect(main(['why', 's.sight', '--line', '2', '--name', 'acc'], io)).toBe(0)
    expect(io.out.join('')).toMatch(/write\s+acc = 6/)
  })

  test('why explains when nothing matches', () => {
    const io = fakeIO({ 'fib.sight': FIB })
    expect(main(['why', 'fib.sight', '--line', '1', '--name', 'nope'], io)).toBe(1)
  })
})

describe('hindsight test', () => {
  test('checks annotated files and summarizes', () => {
    const io = fakeIO({
      'corpus/good.sight': 'print(1 + 1)  // expect: 2\n',
      'corpus/bad.sight': 'print(3)  // expect: 4\n',
    })
    expect(main(['test', 'corpus'], io)).toBe(1)
    const out = io.out.join('')
    expect(out).toContain('✓ good.sight')
    expect(out).toContain('✗ bad.sight')
    expect(out).toContain('1 passed, 1 failed (2 files)')
  })
})

describe('repl', () => {
  test('accumulates entries and prints only new output', () => {
    const io = fakeIO({})
    const session = new ReplSession(io, 42)
    session.handle('var n = 1')
    session.handle('print(n)')
    session.handle('n += 1')
    session.handle('print(n)')
    expect(io.out.join('')).toBe('1\n2\n')
    expect(session.source).toBe('var n = 1\nprint(n)\nn += 1\nprint(n)\n')
  })

  test('discards entries that fail', () => {
    const io = fakeIO({})
    const session = new ReplSession(io, 42)
    session.handle('print(missing)')
    session.handle('print([1][3])')
    expect(session.source).toBe('')
    expect(io.err.join('')).toContain('E020')
    expect(io.err.join('')).toContain('R007')
  })

  test('supports its commands', () => {
    const io = fakeIO({})
    const session = new ReplSession(io, 42)
    expect(session.handle('')).toBe(true)
    session.handle(':help')
    session.handle('let x = 1')
    session.handle(':source')
    session.handle(':reset')
    expect(session.source).toBe('')
    expect(session.handle(':quit')).toBe(false)
    expect(io.out.join('')).toContain('let x = 1')
  })
})

describe('format', () => {
  test('marks an empty span with a single caret', () => {
    const style = makeStyle(false)
    expect(codeFrame('print(1\n', { start: 7, end: 7 }, style)).toEqual([
      '  |',
      '1 | print(1',
      '  |        ^',
    ])
  })

  test('adds color codes only when asked', () => {
    const diagnostic = {
      code: 'E011',
      severity: 'error',
      message: "expected an expression but found ')'",
      span: { start: 6, end: 7 },
    } as const
    expect(formatDiagnostic('f', 'print()', diagnostic, makeStyle(true))).toContain('\u001b[31m')
    expect(formatDiagnostic('f', 'print()', diagnostic, makeStyle(false))).not.toContain('\u001b[')
  })

  test('main prints usage for bad arguments and help', () => {
    const io = fakeIO({})
    expect(main(['frobnicate'], io)).toBe(2)
    expect(io.err.join('')).toContain('Usage:')
    expect(main(['--help'], io)).toBe(0)
    expect(main(['--version'], io)).toBe(0)
    expect(io.out.join('')).toContain('hindsight 0.2.0')
  })
})
