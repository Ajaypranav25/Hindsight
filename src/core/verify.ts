/**
 * The bytecode verifier (ARCHITECTURE §4.4): decodes every instruction, checks operands against
 * the constant pool, frame and upvalues, and runs an abstract interpreter over stack depths.
 * Returns one message per problem; an empty list means the proto is well formed.
 */
import type { Constant, FunctionProto, Program } from './bytecode'
import { isFunctionProto, isPatternConst, Op, OP_NAMES, OPERAND_COUNTS } from './bytecode'
import { BUILTIN_NAMES } from './builtin-names'
import { stackEffect } from './compiler/stack-effects'

const NAME_OPS = new Set<number>([
  Op.GetGlobal,
  Op.SetGlobal,
  Op.DefineGlobal,
  Op.GetField,
  Op.SetField,
])
const JUMP_OPS = new Set<number>([Op.Jump, Op.JumpIfFalse, Op.AndJump, Op.OrJump, Op.IterNext])
const POSITIVE_OPS = new Set<number>([Op.PopN, Op.EndScope, Op.Declare])

class Verifier {
  readonly errors: string[] = []
  /** Instruction start → its length; filled by `decode`. */
  readonly starts = new Map<number, number>()
  readonly depthAt: number[]
  private readonly label: string

  constructor(readonly proto: FunctionProto) {
    this.label = `proto #${proto.id} (${proto.name ?? '<fn>'})`
    this.depthAt = new Array<number>(proto.code.length).fill(-1)
  }

  fail(message: string, ip?: number): void {
    this.errors.push(
      ip === undefined ? `${this.label}: ${message}` : `${this.label} ip ${ip}: ${message}`,
    )
  }

  get code(): readonly number[] {
    return this.proto.code
  }

  get constants(): readonly Constant[] {
    return this.proto.constants
  }

  // -- decoding ------------------------------------------------------------------------------

  private lengthAt(ip: number): number {
    const op = this.code[ip]!
    if (op !== Op.Closure) return 1 + OPERAND_COUNTS[op]!
    const constant = this.constants[this.code[ip + 1]!]
    if (!isFunctionProto(constant)) {
      this.fail('Closure operand is not a function constant', ip)
      return 2
    }
    return 2 + 2 * constant.upvalueCount
  }

  decode(): void {
    const code = this.code
    for (let ip = 0; ip < code.length;) {
      const op = code[ip]!
      if (!Number.isInteger(op) || OP_NAMES[op] === undefined) {
        this.fail(`invalid opcode ${op}`, ip)
        ip += 1
        continue
      }
      const length = this.lengthAt(ip)
      if (ip + length > code.length) this.fail(`${OP_NAMES[op]} operands run past the end`, ip)
      for (let i = ip + 1; i < Math.min(ip + length, code.length); i++) {
        if (!Number.isInteger(code[i]) || code[i]! < 0) this.fail(`invalid operand ${code[i]}`, ip)
      }
      this.starts.set(ip, length)
      ip += length
    }
  }

  // -- operands ------------------------------------------------------------------------------

  private checkConstantOperand(op: number, k: number, ip: number): void {
    const constant = this.constants[k]
    const name = OP_NAMES[op]
    if (constant === undefined) this.fail(`${name} constant ${k} is out of range`, ip)
    else if (op === Op.Const && typeof constant !== 'number' && typeof constant !== 'string') {
      this.fail(`Const ${k} is not a number or string`, ip)
    } else if (NAME_OPS.has(op) && typeof constant !== 'string') {
      this.fail(`${name} constant ${k} is not a name`, ip)
    } else if ((op === Op.Destructure || op === Op.MatchPattern) && !isPatternConst(constant)) {
      this.fail(`${name} constant ${k} is not a pattern`, ip)
    }
  }

  private checkTarget(target: number, ip: number): void {
    if (!this.starts.has(target)) this.fail(`jump target ${target} is not an instruction`, ip)
  }

  checkOperands(ip: number): void {
    const op = this.code[ip]!
    const a = this.code[ip + 1] ?? 0
    if (op === Op.Const || op === Op.Destructure || op === Op.MatchPattern || NAME_OPS.has(op)) {
      this.checkConstantOperand(op, a, ip)
    }
    if (op === Op.MatchPattern) this.checkTarget(this.code[ip + 2] ?? -1, ip)
    if (JUMP_OPS.has(op)) this.checkTarget(a, ip)
    if ((op === Op.GetBuiltin || op === Op.DefineBuiltin) && a >= BUILTIN_NAMES.length) {
      this.fail(`builtin index ${a} is out of range`, ip)
    }
    if ((op === Op.GetUpvalue || op === Op.SetUpvalue) && a >= this.proto.upvalueCount) {
      this.fail(`upvalue ${a} is out of range`, ip)
    }
    if (POSITIVE_OPS.has(op) && a < 1) this.fail(`${OP_NAMES[op]} needs a positive count`, ip)
    if (op === Op.Range && a > 1) this.fail(`Range flag ${a} must be 0 or 1`, ip)
  }

  // -- abstract interpretation ---------------------------------------------------------------

  private checkFrameAccess(ip: number, depth: number): void {
    const op = this.code[ip]!
    const a = this.code[ip + 1]!
    if ((op === Op.GetLocal || op === Op.SetLocal) && a >= depth - (op === Op.SetLocal ? 1 : 0)) {
      this.fail(`local slot ${a} is outside the frame (depth ${depth})`, ip)
    }
    if (op !== Op.Closure) return
    const length = this.starts.get(ip)!
    for (let i = ip + 2; i + 1 < ip + length; i += 2) {
      const isLocal = this.code[i]!
      const index = this.code[i + 1]!
      if (isLocal > 1) this.fail(`capture flag ${isLocal} must be 0 or 1`, ip)
      else if (isLocal === 1 && index > depth)
        this.fail(`captured slot ${index} is outside the frame`, ip)
      else if (isLocal === 0 && index >= this.proto.upvalueCount) {
        this.fail(`captured upvalue ${index} is out of range`, ip)
      }
    }
  }

  private flowTo(target: number, depth: number, from: number, work: number[]): void {
    if (target >= this.code.length) {
      this.fail('execution runs past the end of the code', from)
      return
    }
    if (!this.starts.has(target)) return
    const known = this.depthAt[target]!
    if (known === -1) {
      this.depthAt[target] = depth
      work.push(target)
    } else if (known !== depth) {
      this.fail(`inconsistent stack depth at ${target}: ${known} vs ${depth}`, from)
    }
  }

  interpret(): void {
    if (this.code.length === 0) {
      this.fail('empty code')
      return
    }
    const work: number[] = []
    this.flowTo(0, 1 + this.proto.arity, 0, work)
    while (work.length > 0) {
      const ip = work.pop()!
      const depth = this.depthAt[ip]!
      const effect = stackEffect(this.code, ip, this.constants)
      if (depth < effect.pops) {
        this.fail(
          `stack underflow: ${OP_NAMES[this.code[ip]!]} needs ${effect.pops}, depth ${depth}`,
          ip,
        )
        continue
      }
      this.checkFrameAccess(ip, depth)
      if (effect.jumpDelta !== null) {
        const target = this.code[ip + this.starts.get(ip)! - 1]!
        this.flowTo(target, depth + effect.jumpDelta, ip, work)
      }
      if (effect.fallsThrough) {
        this.flowTo(ip + this.starts.get(ip)!, depth - effect.pops + effect.pushes, ip, work)
      }
    }
  }

  // -- debug info ----------------------------------------------------------------------------

  checkDebug(): void {
    const { debug, code } = this.proto
    const arrays = {
      spanStart: debug.spanStart,
      spanEnd: debug.spanEnd,
      stmtStart: debug.stmtStart,
      stmtSpanStart: debug.stmtSpanStart,
      stmtSpanEnd: debug.stmtSpanEnd,
    }
    for (const [name, array] of Object.entries(arrays)) {
      if (array.length !== code.length) {
        this.fail(`debug.${name} has length ${array.length}, expected ${code.length}`)
      }
    }
    for (let i = 0; i < Math.min(debug.stmtStart.length, code.length); i++) {
      if (debug.stmtStart[i] !== 0 && !this.starts.has(i))
        this.fail('stmtStart set on an operand', i)
    }
    if (debug.upvalueNames.length !== this.proto.upvalueCount) {
      this.fail(
        `${debug.upvalueNames.length} upvalue names for ${this.proto.upvalueCount} upvalues`,
      )
    }
  }

  checkLocals(): void {
    for (const local of this.proto.debug.locals) {
      const where = `local '${local.name}'`
      if (local.slot < 1) this.fail(`${where} has slot ${local.slot}`)
      if (local.startIp < 0 || local.endIp > this.code.length || local.startIp > local.endIp) {
        this.fail(`${where} has an invalid range [${local.startIp}, ${local.endIp})`)
        continue
      }
      const depth = this.depthAt[local.startIp] ?? -1
      if (depth !== -1 && local.slot >= depth) {
        this.fail(
          `${where} slot ${local.slot} is outside the frame (depth ${depth})`,
          local.startIp,
        )
      }
    }
  }
}

/** Problems found in one proto (nested protos are not visited). */
export function verifyProto(proto: FunctionProto): string[] {
  const verifier = new Verifier(proto)
  verifier.decode()
  for (const ip of verifier.starts.keys()) verifier.checkOperands(ip)
  verifier.interpret()
  verifier.checkDebug()
  verifier.checkLocals()
  return verifier.errors
}

/** Problems found in every proto of a program, plus the proto numbering and nesting. */
export function verifyProgram(program: Program): string[] {
  const errors: string[] = []
  const ids = new Set(program.protos.map((p) => p.id))
  program.protos.forEach((proto, i) => {
    if (proto.id !== program.firstProtoId + i) {
      errors.push(`proto at index ${i} has id ${proto.id}, expected ${program.firstProtoId + i}`)
    }
    for (const constant of proto.constants) {
      if (isFunctionProto(constant) && !ids.has(constant.id)) {
        errors.push(`proto #${proto.id} references proto #${constant.id} outside the program`)
      }
    }
    errors.push(...verifyProto(proto))
  })
  if (program.protos[0] !== program.script) errors.push('the script is not the first proto')
  if (program.script.kind !== 'script') errors.push("the script proto's kind is not 'script'")
  return errors
}
