import { describe, expect, test } from 'vitest'
import type { Call, Expr, ExprStmt, ForStmt, Member, Program, Stmt } from './ast'
import { printAst } from './ast-print'
import { parse } from './parser'

/** Each top-level statement, printed. */
function statements(source: string): string[] {
  const result = parse(source)
  expect(result.diagnostics).toEqual([])
  return result.program.body.map((stmt) => printAst(stmt))
}

/** The single statement of `source`, printed. */
function one(source: string): string {
  const printed = statements(source)
  expect(printed).toHaveLength(1)
  return printed[0]!
}

function program(source: string): Program {
  const result = parse(source)
  expect(result.diagnostics).toEqual([])
  return result.program
}

function firstStmt(source: string): Stmt {
  return program(source).body[0]!
}

function firstExpr(source: string): Expr {
  const stmt = firstStmt(source)
  expect(stmt.kind).toBe('ExprStmt')
  return (stmt as ExprStmt).expr
}

describe('parse: programs and statements', () => {
  test('an empty source is an empty program spanning the source', () => {
    // Arrange / Act
    const result = parse('  // nothing\n')

    // Assert
    expect(result.diagnostics).toEqual([])
    expect(result.program).toEqual({ kind: 'Program', body: [], span: { start: 0, end: 13 } })
  })

  test('the SPEC introduction program parses', () => {
    // Arrange
    const source = `fn fib(n) {
  if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
}

for i in 0..10 {
  print("fib({i}) = {fib(i)}")
}`

    // Act / Assert
    expect(statements(source)).toEqual([
      '(fn fib (n) (block (if (< n 2) (block n) (block (+ (call fib (- n 1)) (call fib (- n 2)))))))',
      '(for i (.. 0 10) (block (call print (template "fib(" i ") = " (call fib i) ""))))',
    ])
  })

  test.each([
    ['let x = 1', '(let x 1)'],
    ['var x = 1', '(var x 1)'],
    ['let [a, b] = xs', '(let [a b] xs)'],
    ['fn f() { }', '(fn f () (block))'],
    ['fn f(a, b,) { a }', '(fn f (a b) (block a))'],
    ['return', '(return)'],
    ['return 1', '(return 1)'],
    ['break', '(break)'],
    ['continue', '(continue)'],
    ['while x { y }', '(while x (block y))'],
    ['for [k, v] in entries(r) { k }', '(for [k v] (call entries r) (block k))'],
    ['{ a; b }', '(block a b)'],
    ['{}', '(block)'],
    ['x', 'x'],
    ['x = 1', '(= x 1)'],
    ['x += 1', '(+= x 1)'],
    ['x -= 1', '(-= x 1)'],
    ['x *= 1', '(*= x 1)'],
    ['x /= 1', '(/= x 1)'],
    ['x %= 1', '(%= x 1)'],
    ['a.b = 1', '(= (. a b) 1)'],
    ['a[0] += 1', '(+= (index a 0) 1)'],
    ['(a) = 1', '(= a 1)'],
    ['f().x = 1', '(= (. (call f) x) 1)'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('statements are separated by newlines or semicolons; a trailing semicolon is allowed', () => {
    expect(statements('a; b\nc;')).toEqual(['a', 'b', 'c'])
    expect(statements('{ a\n b; }')).toEqual(['(block a b)'])
  })

  test('fn followed by ( at statement start is an expression statement', () => {
    expect(one('fn(x) { x }(5)')).toBe('(call (fn (x) (block x)) 5)')
  })

  test('return takes a value only from the same line and not before }, ; or end of file', () => {
    expect(statements('fn f() { return\n1 }')).toEqual(['(fn f () (block (return) 1))'])
    expect(statements('fn f() { return }')).toEqual(['(fn f () (block (return)))'])
    expect(statements('fn f() { return; 2 }')).toEqual(['(fn f () (block (return) 2))'])
  })

  test('statement spans exclude the separating semicolon', () => {
    // Arrange / Act
    const body = program('let x = 1;  x = 2').body

    // Assert
    expect(body.map((s) => [s.span.start, s.span.end])).toEqual([
      [0, 9],
      [12, 17],
    ])
  })

  test('declarations record name spans and for headers', () => {
    // Arrange / Act
    const decl = firstStmt('fn go(a) { a }')
    const loop = firstStmt('for x in xs { x }') as ForStmt

    // Assert
    expect(decl).toMatchObject({
      kind: 'FnDecl',
      name: 'go',
      nameSpan: { start: 3, end: 5 },
      span: { start: 0, end: 14 },
      fn: { kind: 'Function', name: 'go', form: 'fn', span: { start: 0, end: 14 } },
    })
    expect(loop.headerSpan).toEqual({ start: 0, end: 11 })
    expect(loop.span).toEqual({ start: 0, end: 17 })
  })
})

describe('parse: literals and primaries', () => {
  test.each([
    ['42', '42'],
    ['1_000.5e1', '10005'],
    ['"hi"', '"hi"'],
    ['"a\\nb"', '"a\\nb"'],
    ['true', 'true'],
    ['false', 'false'],
    ['nil', 'nil'],
    ['name', 'name'],
    ['[]', '(list)'],
    ['[1, 2,]', '(list 1 2)'],
    ['[1, ...xs, 2]', '(list 1 (... xs) 2)'],
    ['({})', '(record)'],
    ['({a:1, "b c":2, d, ...e,})', '(record a:1 "b c":2 d (... e))'],
    ['({if_:1})', '(record if_:1)'],
    ['"a {x} b"', '(template "a " x " b")'],
    ['"{x}{y}"', '(template "" x "" y "")'],
    ['"n = {f("{k}")}"', '(template "n = " (call f (template "" k "")) "")'],
    ['"{ {a:1}.a }"', '(template "" (. (record a:1) a) "")'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('parentheses only group and leave no node', () => {
    expect(one('((x))')).toBe('x')
    expect(firstExpr('(x)').span).toEqual({ start: 1, end: 2 })
  })

  test('record field keys keep spans and shorthand flags', () => {
    expect(firstExpr('({a, "b": 1})')).toMatchObject({
      kind: 'Record',
      span: { start: 1, end: 12 },
      items: [
        { kind: 'Field', key: 'a', shorthand: true, keySpan: { start: 2, end: 3 } },
        { kind: 'Field', key: 'b', shorthand: false, keySpan: { start: 5, end: 8 } },
      ],
    })
  })

  test('a template spans from the opening quote to the closing quote', () => {
    expect(firstExpr('"a {x} b"').span).toEqual({ start: 0, end: 9 })
  })
})

describe('parse: precedence and associativity (SPEC §3.3)', () => {
  test.each([
    ['a |> f or b', '(pipe (or f b) a)'],
    ['a or b and c', '(or a (and b c))'],
    ['a and b or c', '(or (and a b) c)'],
    ['not a and b', '(and (not a) b)'],
    ['not a == b', '(not (== a b))'],
    ['not not a', '(not (not a))'],
    ['a and not b', '(and a (not b))'],
    ['a or not b', '(or a (not b))'],
    ['a |> not b', '(pipe (not b) a)'],
    ['a == b', '(== a b)'],
    ['a != b', '(!= a b)'],
    ['a < b', '(< a b)'],
    ['a <= b', '(<= a b)'],
    ['a > b', '(> a b)'],
    ['a >= b', '(>= a b)'],
    ['a < b..c', '(< a (.. b c))'],
    ['a..b + c', '(.. a (+ b c))'],
    ['a..=b', '(..= a b)'],
    ['a + b * c', '(+ a (* b c))'],
    ['a - b - c', '(- (- a b) c)'],
    ['a * b / c % d', '(% (/ (* a b) c) d)'],
    ['-a * b', '(* (- a) b)'],
    ['-2 ** 2', '(- (** 2 2))'],
    ['2 ** 3 ** 2', '(** 2 (** 3 2))'],
    ['2 ** -1', '(** 2 (- 1))'],
    ['- -a', '(- (- a))'],
    ['a.b(c)[d]', '(index (call (. a b) c) d)'],
    ['-a.b', '(- (. a b))'],
    ['(a < b) == c', '(== (< a b) c)'],
    ['(1..2)..3', '(.. (.. 1 2) 3)'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('a binary span covers its operands including parentheses, with the operator span', () => {
    expect(firstExpr('(a) + b')).toMatchObject({
      kind: 'Binary',
      span: { start: 0, end: 7 },
      opSpan: { start: 4, end: 5 },
    })
  })
})

describe('parse: postfix expressions', () => {
  test.each([
    ['f()', '(call f)'],
    ['f(a, b,)', '(call f a b)'],
    ['f(a)(b)', '(call (call f a) b)'],
    ['a[0][1]', '(index (index a 0) 1)'],
    ['a.b.c', '(. (. a b) c)'],
    ['a._', '(. a _)'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('a member access records the name span and the span from the dot', () => {
    // Arrange / Act
    const member = firstExpr('obj . name') as Member

    // Assert
    expect(member.span).toEqual({ start: 0, end: 10 })
    expect(member.nameSpan).toEqual({ start: 6, end: 10 })
    expect(member.accessSpan).toEqual({ start: 4, end: 10 })
  })

  test('calls written without a pipe have no pipe span', () => {
    expect(firstExpr('f(x)')).toMatchObject({
      pipe: false,
      pipeSpan: null,
      span: { start: 0, end: 4 },
    })
  })
})

describe('parse: pipes (SPEC §7.11)', () => {
  test.each([
    ['x |> f', '(pipe f x)'],
    ['x |> f(a, b)', '(pipe f x a b)'],
    ['x |> f(a)(b)', '(pipe (call f a) x b)'],
    ['x |> f |> g', '(pipe g (pipe f x))'],
    ['x |> (f(a))', '(pipe f x a)'],
    ['x |> a.b', '(pipe (. a b) x)'],
    ['x |> |y| y', '(pipe (lambda (y) y) x)'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('the call spans the whole pipe and pipeSpan runs from |> to the end of the right side', () => {
    // Arrange / Act
    const call = firstExpr('xs |> map(f)') as Call

    // Assert
    expect(call.span).toEqual({ start: 0, end: 12 })
    expect(call.pipeSpan).toEqual({ start: 3, end: 12 })
  })

  test('the pipeline style continues across lines', () => {
    // Arrange
    const source = `let total = orders
  |> filter(|o| o.paid)
  |> map(|o| o.amount)
  |> sum()`

    // Act / Assert
    expect(one(source)).toBe(
      '(let total (pipe sum (pipe map (pipe filter orders (lambda (o) (. o paid))) (lambda (o) (. o amount)))))',
    )
  })
})

describe('parse: functions and lambdas', () => {
  test.each([
    ['|| 42', '(lambda () 42)'],
    ['| | 42', '(lambda () 42)'],
    ['|/* c */| 42', '(lambda () 42)'],
    ['|a| a + 1', '(lambda (a) (+ a 1))'],
    ['|a, b,| a', '(lambda (a b) a)'],
    ['|[a, b], {c}| a', '(lambda ([a b] {c}) a)'],
    ['|x| { x }', '(lambda (x) (block x))'],
    ['|x| x + 1 |> f', '(lambda (x) (pipe f (+ x 1)))'],
    ['|x| ({x})', '(lambda (x) (record x))'],
    ['fn(a) { a }', '(fn (a) (block a))'],
    ['let f = (|x| x)', '(let f (lambda (x) x))'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('a lambda block body inside arguments is newline-sensitive again', () => {
    // Arrange
    const source = `map(xs, |x| {
  let y = x
  -y
})`

    // Act / Assert
    expect(one(source)).toBe('(call map xs (lambda (x) (block (let y x) (- y))))')
  })

  test('functions have form, null name and the full span', () => {
    expect(firstExpr('|x| x')).toMatchObject({
      kind: 'Function',
      form: 'lambda',
      name: null,
      span: { start: 0, end: 5 },
    })
  })
})

describe('parse: if and match', () => {
  test.each([
    ['if a { 1 }', '(if a (block 1))'],
    ['if a { 1 } else { 2 }', '(if a (block 1) (block 2))'],
    ['if a { 1 } else if b { 2 } else { 3 }', '(if a (block 1) (if b (block 2) (block 3)))'],
    ['if a { 1 }\nelse { 2 }', '(if a (block 1) (block 2))'],
    ['match x { }', '(match x)'],
    ['match x { 1 => a, _ => b }', '(match x (arm 1 a) (arm _ b))'],
    ['match x { n if n > 0 => n }', '(match x (arm n (if (> n 0)) n))'],
    ['match x { 1 | 2 => { a } }', '(match x (arm (| 1 2) (block a)))'],
    ['match x { [a, ...] => a, }', '(match x (arm [a ...] a))'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('match arms are newline-separated even inside call parentheses', () => {
    // Arrange
    const source = `print(match xs {
  [] => "empty"
  [x] => "one"
  _ => "many"
})`

    // Act / Assert
    expect(one(source)).toBe(
      '(call print (match xs (arm [] "empty") (arm [x] "one") (arm _ "many")))',
    )
  })

  test('an arm body expression stops at the end of its line', () => {
    expect(one('match x {\n 1 => a\n [b] => b\n}')).toBe('(match x (arm 1 a) (arm [b] b))')
  })
})

describe('parse: newline sensitivity (SPEC §3.2)', () => {
  test('the documented consequences', () => {
    // Arrange
    const source = `let a = 1
-2
let b = 1 -
  2
f
(x)`

    // Act / Assert
    expect(statements(source)).toEqual(['(let a 1)', '(- 2)', '(let b (- 1 2))', 'f', 'x'])
  })

  test.each([
    ['a\n[0]', ['a', '(list 0)']],
    ['a\n(0)', ['a', '0']],
    ['a\n.b', ['(. a b)']],
    ['a\n|> f', ['(pipe f a)']],
    ['a\n-1', ['a', '(- 1)']],
    ['{ a\n[0] }', ['(block a (list 0))']],
  ])('in a block or at top level: %j', (source, expected) => {
    expect(statements(source)).toEqual(expected)
  })

  test.each(['+', '*', '/', '%', '**', '==', '!=', '<', '<=', '>', '>=', '..', '..=', 'and', 'or'])(
    'a binary operator %s starting a line does not continue the expression',
    (op) => {
      expect(parse(`a\n${op} b`).diagnostics[0]?.code).toBe('E011')
    },
  )

  test.each(['=', '+=', '-=', '*=', '/=', '%=', '+', 'and'])(
    'an operator ending the line continues the expression: a %s',
    (op) => {
      expect(one(`a ${op}\n 1`)).toBe(`(${op} a 1)`)
    },
  )

  test.each([
    ['(a\n+ b)', '(+ a b)'],
    ['[a\n, b\n]', '(list a b)'],
    ['f(a\n(b))', '(call f (call a b))'],
    ['({a:x\n+ 1})', '(record a:(+ x 1))'],
    ['"{a\n+ b}"', '(template "" (+ a b) "")'],
    ['a[i\n- 1]', '(index a (- i 1))'],
  ])('insensitive contexts continue across lines: %j', (source, expected) => {
    expect(one(source)).toBe(expected)
  })

  test('if, while and for headers inherit the enclosing context', () => {
    expect(one('(if a\n== b { 1 })')).toBe('(if (== a b) (block 1))')
    expect(parse('if a\n== b { 1 }').diagnostics[0]?.message).toBe("expected '{' but found '=='")
  })

  test('a block nested inside brackets is newline-sensitive again', () => {
    expect(one('f(if c {\n a\n -1\n})')).toBe('(call f (if c (block a (- 1))))')
  })

  test('assignment operators on a new line start a new statement', () => {
    expect(parse('x\n= 1').diagnostics[0]?.code).toBe('E011')
  })
})

describe('parse: blocks versus records (SPEC §3.1)', () => {
  test.each([
    ['{ a }', '(block a)'],
    ['let r = {a:1}', '(let r (record a:1))'],
    ['f({a})', '(call f (record a))'],
    ['[{}]', '(list (record))'],
    ['x = {}', '(= x (record))'],
    ['return {}', '(return (record))'],
    ['if c { a } else { b }', '(if c (block a) (block b))'],
    ['while c { }', '(while c (block))'],
    ['for x in {} { }', '(for x (record) (block))'],
    ['|x| {}', '(lambda (x) (block))'],
    ['fn() {}', '(fn () (block))'],
    ['match x { _ => {} }', '(match x (arm _ (block)))'],
    ['match {} { }', '(match (record))'],
    ['if {a:1}.a { }', '(if (. (record a:1) a) (block))'],
  ])('%s', (source, expected) => {
    expect(one(source)).toBe(expected)
  })
})

describe('parse: patterns (SPEC §6)', () => {
  test.each([
    ['_', '_'],
    ['x', 'x'],
    ['42', '42'],
    ['-1.5', '-1.5'],
    ['-0', '-0'],
    ['"hi"', '"hi"'],
    ['true', 'true'],
    ['false', 'false'],
    ['nil', 'nil'],
    ['1..10', '1..10'],
    ['-5..=5', '-5..=5'],
    ['-5..-1', '-5..-1'],
    ['[]', '[]'],
    ['[a, b,]', '[a b]'],
    ['[first, ...]', '[first ...]'],
    ['[..._]', '[...]'],
    ['[a, ...rest, z]', '[a ...rest z]'],
    ['{}', '{}'],
    ['{name, age: a, "x y": p}', '{name age:a "x y":p}'],
    ['{_}', '{_}'],
    ['1 | 2 | 3', '(| 1 2 3)'],
    ['[1 | 2, _]', '[(| 1 2) _]'],
    ['{k: "a" | "b"}', '{k:(| "a" "b")}'],
  ])('match pattern %s', (pattern, expected) => {
    expect(one(`match v { ${pattern} => 0 }`)).toBe(`(match v (arm ${expected} 0))`)
  })

  test('pattern nodes carry their values and spans', () => {
    // Arrange / Act
    const decl = firstStmt('let [a, ...rest] = xs')

    // Assert
    expect(decl).toMatchObject({
      kind: 'Let',
      pattern: {
        kind: 'PList',
        span: { start: 4, end: 16 },
        before: [{ kind: 'PBind', name: 'a', span: { start: 5, end: 6 } }],
        rest: { kind: 'PRest', name: 'rest', span: { start: 8, end: 15 } },
        after: [],
      },
    })
  })

  test('range and record patterns keep their fields', () => {
    expect(firstStmt('match v { -2..=3 => 0 }')).toMatchObject({
      expr: {
        arms: [
          {
            pattern: {
              kind: 'PRange',
              start: -2,
              end: 3,
              inclusive: true,
              span: { start: 10, end: 16 },
            },
          },
        ],
      },
    })
    expect(firstStmt('let {"k": p, s} = r')).toMatchObject({
      pattern: {
        kind: 'PRecord',
        fields: [
          {
            key: 'k',
            keySpan: { start: 5, end: 8 },
            shorthand: false,
            pattern: { kind: 'PBind', name: 'p' },
          },
          {
            key: 's',
            shorthand: true,
            pattern: { kind: 'PBind', name: 's', span: { start: 13, end: 14 } },
          },
        ],
      },
    })
  })

  test('patterns may span lines', () => {
    expect(one('match v {\n 1\n | 2 => 0\n}')).toBe('(match v (arm (| 1 2) 0))')
  })
})
