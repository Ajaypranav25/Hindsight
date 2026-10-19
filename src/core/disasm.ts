/**
 * The disassembler (ARCHITECTURE §4.4): one line per instruction, `ip  OPNAME operands  ; comment`,
 * with constant values, names, jump targets and line numbers; nested protos follow their parent.
 */
import type { Constant, FunctionProto, Program } from './bytecode'
import { instructionLength, isFunctionProto, isPatternConst, Op, OP_NAMES } from './bytecode'
import { BUILTIN_NAMES } from './builtin-names'
import { LineIndex } from './span'

const NAME_OPS = new Set<number>([
  Op.GetGlobal,
  Op.SetGlobal,
  Op.DefineGlobal,
  Op.GetField,
  Op.SetField,
])
const JUMP_OPS = new Set<number>([Op.Jump, Op.JumpIfFalse, Op.AndJump, Op.OrJump, Op.IterNext])

function formatIp(ip: number): string {
  return String(ip).padStart(4, '0')
}

function constantText(constant: Constant | undefined): string {
  if (typeof constant === 'string') return JSON.stringify(constant)
  if (typeof constant === 'number') return Object.is(constant, -0) ? '-0' : String(constant)
  if (isFunctionProto(constant)) {
    return `${constant.name === null ? '<fn>' : `<fn ${constant.name}>`} #${constant.id}`
  }
  if (isPatternConst(constant)) return constant.text
  return '?'
}

function localName(proto: FunctionProto, slot: number, ip: number): string | undefined {
  const local = proto.debug.locals.find((l) => l.slot === slot && l.startIp <= ip && ip < l.endIp)
  return local?.name
}

function declaredNames(proto: FunctionProto, ip: number, count: number): string {
  const after = ip + 2
  return proto.debug.locals
    .filter((l) => l.startIp === after)
    .sort((a, b) => a.slot - b.slot)
    .slice(-count)
    .map((l) => l.name)
    .join(', ')
}

interface Decoded {
  readonly operands: string
  readonly comment: string
}

function decodeClosure(proto: FunctionProto, ip: number, length: number): Decoded {
  const code = proto.code
  const captures: string[] = []
  for (let i = ip + 2; i < ip + length; i += 2) {
    captures.push(`${code[i] === 1 ? 'local' : 'upvalue'} ${code[i + 1]}`)
  }
  const list = captures.length > 0 ? ` (${captures.join(', ')})` : ''
  return {
    operands: `${code[ip + 1]}${list}`,
    comment: constantText(proto.constants[code[ip + 1]!]),
  }
}

function commentFor(proto: FunctionProto, op: number, a: number, ip: number): string {
  const { constants, debug } = proto
  if (op === Op.Const || op === Op.Destructure || NAME_OPS.has(op)) {
    return NAME_OPS.has(op) ? String(constants[a]) : constantText(constants[a])
  }
  if (op === Op.GetBuiltin || op === Op.DefineBuiltin) return BUILTIN_NAMES[a] ?? '?'
  if (op === Op.GetLocal || op === Op.SetLocal) return localName(proto, a, ip) ?? ''
  if (op === Op.GetUpvalue || op === Op.SetUpvalue) return debug.upvalueNames[a] ?? ''
  if (op === Op.Declare) return declaredNames(proto, ip, a)
  if (op === Op.Range) return a === 1 ? '..=' : '..'
  if (JUMP_OPS.has(op)) return `-> ${formatIp(a)}`
  return ''
}

function decode(proto: FunctionProto, ip: number, length: number): Decoded {
  const code = proto.code
  const op = code[ip]!
  if (op === Op.Closure) return decodeClosure(proto, ip, length)
  if (op === Op.MatchPattern) {
    const text = constantText(proto.constants[code[ip + 1]!])
    return {
      operands: `${code[ip + 1]} ${code[ip + 2]}`,
      comment: `${text} -> ${formatIp(code[ip + 2]!)}`,
    }
  }
  const operands = code.slice(ip + 1, ip + length).join(' ')
  return { operands, comment: length > 1 ? commentFor(proto, op, code[ip + 1]!, ip) : '' }
}

function safeLength(proto: FunctionProto, ip: number): number {
  const op = proto.code[ip]!
  if (OP_NAMES[op] === undefined) return 1
  if (op === Op.Closure && !isFunctionProto(proto.constants[proto.code[ip + 1]!])) return 2
  return Math.min(instructionLength(proto.code, ip, proto.constants), proto.code.length - ip)
}

function header(proto: FunctionProto): string {
  const name = proto.name ?? '<fn>'
  const library = proto.debug.library ? ', library' : ''
  return `== ${name} #${proto.id} (${proto.kind}, arity ${proto.arity}, upvalues ${proto.upvalueCount}${library}) ==`
}

function disassembleProto(proto: FunctionProto, lines: LineIndex | null): string[] {
  const out = [header(proto)]
  let lastLine = -1
  for (let ip = 0; ip < proto.code.length;) {
    const length = safeLength(proto, ip)
    const name = OP_NAMES[proto.code[ip]!] ?? `??? ${proto.code[ip]}`
    const { operands, comment } = decode(proto, ip, length)
    const notes = comment === '' ? [] : [comment]
    const line = lines?.lineOf(proto.debug.spanStart[ip] ?? 0)
    if (line !== undefined && line !== lastLine) notes.push(`line ${line}`)
    lastLine = line ?? lastLine
    const head = `${formatIp(ip)}  ${name}${operands === '' ? '' : ` ${operands}`}`
    out.push(notes.length > 0 ? `${head}  ; ${notes.join('  ')}` : head)
    ip += length
  }
  return out
}

/** Every proto reachable from `root` through its constants, in id order. */
function reachableProtos(root: FunctionProto): FunctionProto[] {
  const seen = new Map<number, FunctionProto>()
  const work = [root]
  while (work.length > 0) {
    const proto = work.pop()!
    if (seen.has(proto.id)) continue
    seen.set(proto.id, proto)
    for (const constant of proto.constants) if (isFunctionProto(constant)) work.push(constant)
  }
  return [...seen.values()].sort((a, b) => a.id - b.id)
}

/** The disassembly of a program (all its protos) or of one proto and the protos it contains. */
export function disassemble(target: Program | FunctionProto): string {
  const isProto = 'tag' in target && target.tag === 'proto'
  const protos = isProto ? reachableProtos(target) : (target as Program).protos
  const lines = isProto ? null : new LineIndex((target as Program).source)
  return protos.map((proto) => disassembleProto(proto, lines).join('\n')).join('\n\n')
}
