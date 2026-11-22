import { describe, expect, test } from 'vitest'
import { isContractConst, type FunctionProto, Op } from '../bytecode'
import { codeOf, compileOk, diagnosticsOf, spanOf } from './test-support'

function protoOf(source: string, index = 1): FunctionProto {
  return compileOk(source).protos[index]!
}

/** The code indices where a statement starts. */
function stmtStarts(proto: FunctionProto): number[] {
  const starts: number[] = []
  proto.debug.stmtStart.forEach((flag, ip) => {
    if (flag === 1) starts.push(ip)
  })
  return starts
}

describe('contract emission (ARCHITECTURE §4.3.3)', () => {
  test('requires: each clause, then Check k, after the parameter prologue', () => {
    // Arrange
    const source = 'fn f([a, b]) requires a < b { b - a }'

    // Act / Assert
    expect(codeOf(source, 1)).toEqual([
      '0000  GetLocal 1  ; $arg0  line 1',
      '0002  Destructure 0  ; [a, b]',
      '0004  Declare 2  ; a, b',
      '0006  GetLocal 2  ; a',
      '0008  GetLocal 3  ; b',
      '0010  Lt',
      '0011  Check 1  ; requires a < b',
      '0013  GetLocal 3  ; b',
      '0015  GetLocal 2  ; a',
      '0017  Sub',
      '0018  Return',
    ])
  })

  test('ensures at the end of the body: Declare 1 (result), each clause with Check, Return', () => {
    // Arrange
    const source = 'fn f(x) ensures result > x {\n  x + 1\n}'

    // Act / Assert
    expect(codeOf(source, 1)).toEqual([
      '0000  GetLocal 1  ; x  line 2',
      '0002  Const 1  ; 1',
      '0004  Add',
      '0005  Declare 1  ; result  line 3',
      '0007  GetLocal 2  ; result  line 1',
      '0009  GetLocal 1  ; x',
      '0011  Gt',
      '0012  Check 0  ; ensures result > x',
      '0014  Return  ; line 3',
    ])
  })

  test('every return statement checks the postconditions before Return', () => {
    // Arrange
    const source = 'fn f(x) ensures result != 0 {\n  if x { return 1 }\n  2\n}'

    // Act
    const code = codeOf(source, 1)

    // Assert
    expect(code.filter((line) => line.includes('Check 0'))).toHaveLength(2)
    expect(code.filter((line) => line.includes('Declare 1  ; result'))).toHaveLength(2)
    expect(code.filter((line) => / Return/.test(line))).toHaveLength(2)
  })

  test('a function without contracts compiles exactly as before', () => {
    // Arrange / Act / Assert
    expect(codeOf('fn f(x) {\n  if x { return 1 }\n  2\n}', 1)).toEqual([
      '0000  GetLocal 1  ; x  line 2',
      '0002  JumpIfFalse 10  ; -> 0010',
      '0004  Const 0  ; 1',
      '0006  Return',
      '0007  Nil',
      '0008  Jump 11  ; -> 0011',
      '0010  Nil',
      '0011  Pop',
      '0012  Const 1  ; 2  line 3',
      '0014  Return  ; line 4',
    ])
  })

  test('the contract constant holds the kind, the clause text, the name and the parameters', () => {
    // Arrange
    const proto = protoOf('let g = fn(n, [a]) requires n  >=  a { n }\nfn h() ensures true { 1 }')

    // Act
    const contracts = proto.constants.filter(isContractConst)
    const other = compileOk('fn h() ensures true { 1 }').protos[1]!.constants.filter(
      isContractConst,
    )

    // Assert
    expect(contracts).toEqual([
      { tag: 'contract', kind: 'requires', text: 'n  >=  a', fn: 'g', params: ['n', '[a]'] },
    ])
    expect(other).toEqual([{ tag: 'contract', kind: 'ensures', text: 'true', fn: 'h', params: [] }])
  })

  test('an unnamed function is called lambda in its contract constants', () => {
    // Arrange
    const program = compileOk('print(fn(x) requires x { x }(1))')

    // Act
    const [contract] = program.protos[1]!.constants.filter(isContractConst)

    // Assert
    expect(contract?.fn).toBe('lambda')
  })
})

describe('contract debug info (ARCHITECTURE §4.3.5)', () => {
  test('each clause is a statement start whose spans are the clause expression', () => {
    // Arrange
    const source = 'fn f(x)\n  requires x > 0\n  ensures result > 1\n{\n  x + 1\n}'
    const proto = protoOf(source)
    const requiresSpan = spanOf(source, 'x > 0')
    const ensuresSpan = spanOf(source, 'result > 1')

    // Act
    const starts = stmtStarts(proto)
    const checks = [...proto.code.keys()].filter((ip) => proto.code[ip] === Op.Check)

    // Assert: the requires clause, the body, the ensures clause.
    expect(starts).toEqual([0, 7, 14])
    expect(checks).toEqual([5, 19])
    for (const [first, check, span] of [
      [0, 5, requiresSpan],
      [14, 19, ensuresSpan],
    ] as const) {
      expect([proto.debug.stmtSpanStart[first], proto.debug.stmtSpanEnd[first]]).toEqual([
        span.start,
        span.end,
      ])
      expect([proto.debug.spanStart[check], proto.debug.spanEnd[check]]).toEqual([
        span.start,
        span.end,
      ])
    }
  })

  test('result is a local of kind result over the clauses and the Return', () => {
    // Arrange
    const source = 'fn f(x) ensures result > x { x + 1 }'
    const proto = protoOf(source)

    // Act
    const result = proto.debug.locals.find((local) => local.name === 'result')

    // Assert
    expect(result).toMatchObject({
      slot: 2,
      kind: 'result',
      mutable: false,
      hidden: false,
      startIp: 7,
      endIp: 15,
      declSpan: spanOf(source, 'result > x'),
    })
  })
})

describe('contract names (SPEC §7.16)', () => {
  test('a clause cannot see the body locals in scope at a return', () => {
    // Arrange / Act
    const diagnostics = diagnosticsOf('fn f(x) ensures result == y {\n  let y = 1\n  return y\n}')

    // Assert
    expect(diagnostics.map((d) => d.message)).toEqual(["undefined variable 'y'"])
  })

  test('return inside a clause is E029; break inside a clause is E024', () => {
    // Arrange / Act
    const diagnostics = diagnosticsOf(
      'fn f(xs) {\n  for x in xs {\n    fn g(y) requires if y { break } else { return 1 } { y }\n  }\n}',
    )

    // Assert
    expect(diagnostics.map((d) => d.code)).toEqual(['E024', 'E029'])
  })

  test('assigning to result is E021 with its own reason', () => {
    // Arrange / Act
    const [first] = diagnosticsOf('fn f(x) ensures (fn() { result = 1 })() == nil { x }')

    // Assert
    expect(first?.message).toBe("cannot assign to 'result' because it is the function's result")
  })

  test('clauses may capture variables of the enclosing function', () => {
    // Arrange / Act / Assert
    expect(
      diagnosticsOf('fn outer(k) {\n  fn inner(x) requires x < k { x }\n  inner(1)\n}'),
    ).toEqual([])
  })
})
