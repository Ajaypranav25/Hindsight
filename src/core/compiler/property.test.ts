import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { verifyProgram } from '../verify'
import { compileSource } from './test-support'

type Choose = (count: number) => number

interface Variable {
  readonly name: string
  readonly mutable: boolean
}

/**
 * Writes a random valid program over a subset of the grammar. Every choice goes through `choose`,
 * so fast-check can shrink failures. Names are only referenced where they are visible, assignments
 * only target `var`s, and `break`/`continue`/`return` only appear where they are allowed.
 */
class ProgramWriter {
  private nextName = 0
  private readonly scopes: Variable[][] = [[]]
  private loopDepth = 0
  private functionDepth = 0
  private budget = 60

  constructor(private readonly choose: Choose) {}

  program(): string {
    return this.statements(2 + this.choose(8), false).join('\n')
  }

  private fresh(): string {
    return `v${this.nextName++}`
  }

  private visible(): Variable[] {
    return this.scopes.flat()
  }

  private withScope<T>(body: () => T, loop = 0, fn = 0): T {
    const savedLoop = this.loopDepth
    this.scopes.push([])
    this.loopDepth = fn === 1 ? 0 : savedLoop + loop
    this.functionDepth += fn
    const result = body()
    this.functionDepth -= fn
    this.loopDepth = savedLoop
    this.scopes.pop()
    return result
  }

  private declareVariable(name: string, mutable: boolean): void {
    this.scopes[this.scopes.length - 1]!.push({ name, mutable })
  }

  private statements(count: number, valueBlock: boolean): string[] {
    const out: string[] = []
    for (let i = 0; i < count; i++) out.push(this.statement())
    if (valueBlock) out.push(this.safeExpr(2))
    return out
  }

  private block(loop = 0, fn = 0): string {
    return this.withScope(
      () => `{\n${this.statements(this.choose(3), true).join('\n')}\n}`,
      loop,
      fn,
    )
  }

  private statement(): string {
    this.budget--
    const kind = this.budget <= 0 ? 0 : this.choose(11)
    switch (kind) {
      case 0:
      case 1:
        return this.safeExpr(3)
      case 2:
        return this.declaration()
      case 3:
        return this.assignment()
      case 4:
        return `while ${this.expr(1)} ${this.block(1)}`
      case 5:
        return this.forLoop()
      case 6:
        return this.functionDeclaration()
      case 7:
        return this.block()
      case 8:
        return this.loopDepth > 0 ? (this.choose(2) === 0 ? 'break' : 'continue') : 'nil'
      case 9:
        return this.functionDepth > 0 ? `return ${this.expr(2)}` : 'nil'
      default:
        return this.destructuring()
    }
  }

  private destructuring(): string {
    const mutable = this.choose(2) === 0
    const init = this.expr(2)
    const [first, rest] = [this.fresh(), this.fresh()]
    this.declareVariable(first, mutable)
    this.declareVariable(rest, mutable)
    return `${mutable ? 'var' : 'let'} [${first}, ...${rest}] = ${init}`
  }

  /** An expression that may stand where `{` would start a block. */
  private safeExpr(depth: number): string {
    const text = this.expr(depth)
    return text.startsWith('{') ? `(${text})` : text
  }

  private declaration(): string {
    const mutable = this.choose(2) === 0
    const init = this.expr(3)
    const name = this.fresh()
    this.declareVariable(name, mutable)
    return `${mutable ? 'var' : 'let'} ${name} = ${init}`
  }

  private assignment(): string {
    const targets = this.visible().filter((v) => v.mutable)
    if (targets.length === 0) return 'nil'
    const target = targets[this.choose(targets.length)]!.name
    const op = ['=', '+=', '-=', '*='][this.choose(4)]!
    return `${target} ${op} ${this.expr(2)}`
  }

  private forLoop(): string {
    const iterable = this.expr(1)
    return this.withScope(() => {
      const name = this.fresh()
      const pattern = this.choose(3) === 0 ? '_' : name
      if (pattern !== '_') this.declareVariable(name, false)
      return `for ${pattern} in [${iterable}] ${this.block()}`
    }, 1)
  }

  private functionDeclaration(): string {
    const name = this.fresh()
    this.declareVariable(name, false)
    return `fn ${name}${this.parametersAndBody()}`
  }

  private parametersAndBody(): string {
    return this.withScope(
      () => {
        const params = Array.from({ length: this.choose(3) }, () => this.parameter())
        return `(${params.join(', ')}) ${this.block()}`
      },
      0,
      1,
    )
  }

  private parameter(): string {
    const name = this.fresh()
    this.declareVariable(name, false)
    switch (this.choose(4)) {
      case 0:
        return `[${name}]`
      case 1:
        return `{k: ${name}}`
      default:
        return name
    }
  }

  private expr(depth: number): string {
    const leaf = depth <= 0 || this.budget <= 0
    const kind = leaf ? this.choose(4) : this.choose(14)
    switch (kind) {
      case 0:
        return String(this.choose(10))
      case 1:
        return ['"s"', 'true', 'nil', 'PI'][this.choose(4)]!
      case 2:
      case 3:
        return this.reference()
      case 4:
        return `(${this.expr(depth - 1)} ${['+', '-', '*', '<', '==', 'and', 'or', '..'][this.choose(8)]} ${this.expr(depth - 1)})`
      case 5:
        return `[${this.expr(depth - 1)}, ...[${this.expr(depth - 1)}]]`
      case 6:
        return `{k: ${this.expr(depth - 1)}, ...{}}.k`
      case 7:
        return `if ${this.expr(depth - 1)} ${this.block()} else ${this.block()}`
      case 8:
        return `(str(${this.expr(depth - 1)}) |> len)`
      case 9:
        return this.lambda(depth)
      case 10:
        return this.match(depth)
      case 11:
        return `"t{${this.expr(depth - 1)}}"`
      case 12:
        return `[${this.expr(depth - 1)}][0]`
      default:
        return `(not ${this.expr(depth - 1)})`
    }
  }

  private reference(): string {
    const names = this.visible()
    if (names.length === 0) return 'len'
    return names[this.choose(names.length)]!.name
  }

  private lambda(depth: number): string {
    return this.withScope(
      () => {
        const name = this.fresh()
        this.declareVariable(name, false)
        const body = this.choose(2) === 0 ? this.safeExpr(depth - 1) : this.block()
        return `(|${name}| ${body})(${this.choose(10)})`
      },
      0,
      1,
    )
  }

  private match(depth: number): string {
    const subject = this.expr(depth - 1)
    const arms: string[] = []
    const count = this.choose(4)
    for (let i = 0; i < count; i++) {
      arms.push(
        this.withScope(() => {
          const name = this.fresh()
          const patterns = [`[${name}, ..._]`, name, '1 | "s"', `{k: ${name}}`, '0..=9']
          const pattern = patterns[this.choose(patterns.length)]!
          if (pattern.includes(name)) this.declareVariable(name, false)
          const guard = this.choose(2) === 0 ? ` if ${this.expr(0)}` : ''
          return `${pattern}${guard} => ${this.safeExpr(depth - 1)}`
        }),
      )
    }
    return `match ${subject} {\n${arms.join('\n')}\n}`
  }
}

describe('generated programs', () => {
  test('compile without diagnostics and verify cleanly', () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const choose: Choose = (count) => (count <= 1 ? 0 : g(fc.nat, { max: count - 1 }))
        const source = new ProgramWriter(choose).program()
        const output = compileSource(source)
        expect(output.diagnostics).toEqual([])
        expect(verifyProgram(output.program!)).toEqual([])
      }),
      { numRuns: 400 },
    )
  })
})
