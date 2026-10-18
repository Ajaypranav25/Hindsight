/**
 * Bytecode contract between the compiler and the VM (docs/ARCHITECTURE.md §5).
 *
 * Code is a flat number array: an opcode followed by its operands, one array element per operand.
 * Jump targets are absolute code indices.
 */
import type { Diagnostic } from './diagnostics'
import type { Span } from './span'

export const Op = {
  Const: 0,
  Nil: 1,
  True: 2,
  False: 3,
  Pop: 4,
  PopN: 5,
  EndScope: 6,
  Dup: 7,
  Dup2: 8,
  GetLocal: 9,
  SetLocal: 10,
  GetUpvalue: 11,
  SetUpvalue: 12,
  GetGlobal: 13,
  DefineGlobal: 14,
  SetGlobal: 15,
  GetBuiltin: 16,
  DefineBuiltin: 17,
  Declare: 18,
  GetField: 19,
  SetField: 20,
  GetIndex: 21,
  SetIndex: 22,
  Add: 23,
  Sub: 24,
  Mul: 25,
  Div: 26,
  Mod: 27,
  Pow: 28,
  Neg: 29,
  Not: 30,
  Eq: 31,
  Ne: 32,
  Lt: 33,
  Le: 34,
  Gt: 35,
  Ge: 36,
  Range: 37,
  Jump: 38,
  JumpIfFalse: 39,
  AndJump: 40,
  OrJump: 41,
  Call: 42,
  Return: 43,
  Closure: 44,
  List: 45,
  ListAppend: 46,
  ListExtend: 47,
  Record: 48,
  RecordSet: 49,
  RecordMerge: 50,
  Interp: 51,
  IterInit: 52,
  IterNext: 53,
  Destructure: 54,
  MatchPattern: 55,
  NoMatch: 56,
} as const

export type OpName = keyof typeof Op
export type OpCode = (typeof Op)[OpName]

/** Opcode → mnemonic. */
export const OP_NAMES: readonly OpName[] = (() => {
  const names: OpName[] = []
  for (const [name, code] of Object.entries(Op) as [OpName, OpCode][]) names[code] = name
  return names
})()

/**
 * Fixed operand counts per opcode. `Closure` lists 1 here (the constant index); its capture pairs
 * follow and are counted by `instructionLength`.
 */
export const OPERAND_COUNTS: readonly number[] = (() => {
  const counts: number[] = new Array<number>(OP_NAMES.length).fill(0)
  const withOne: OpName[] = [
    'Const',
    'PopN',
    'EndScope',
    'GetLocal',
    'SetLocal',
    'GetUpvalue',
    'SetUpvalue',
    'GetGlobal',
    'DefineGlobal',
    'SetGlobal',
    'GetBuiltin',
    'DefineBuiltin',
    'Declare',
    'GetField',
    'SetField',
    'Range',
    'Jump',
    'JumpIfFalse',
    'AndJump',
    'OrJump',
    'Call',
    'Closure',
    'List',
    'Record',
    'Interp',
    'IterNext',
    'Destructure',
  ]
  for (const name of withOne) counts[Op[name]] = 1
  counts[Op.MatchPattern] = 2
  return counts
})()

/** Number of code elements occupied by the instruction at `ip`, operands included. */
export function instructionLength(
  code: readonly number[],
  ip: number,
  constants: readonly Constant[],
): number {
  const op = code[ip]!
  if (op === Op.Closure) {
    const proto = constants[code[ip + 1]!] as FunctionProto
    return 2 + 2 * proto.upvalueCount
  }
  return 1 + OPERAND_COUNTS[op]!
}

// ---------------------------------------------------------------------------------------------
// Constants

export type Constant = number | string | FunctionProto | PatternConst

/** A compiled pattern (ARCHITECTURE §4.3.4, SPEC §6). */
export type PatternDesc =
  | { readonly t: 'any' }
  | { readonly t: 'bind' }
  | { readonly t: 'lit'; readonly value: number | string | boolean | null }
  | {
      readonly t: 'range'
      readonly start: number
      readonly end: number
      readonly inclusive: boolean
    }
  | {
      readonly t: 'list'
      readonly before: readonly PatternDesc[]
      readonly rest: 'none' | 'discard' | 'bind'
      readonly after: readonly PatternDesc[]
    }
  | {
      readonly t: 'record'
      readonly fields: readonly { readonly key: string; readonly pattern: PatternDesc }[]
    }
  | { readonly t: 'or'; readonly alternatives: readonly PatternDesc[] }

export interface PatternConst {
  readonly tag: 'pattern'
  readonly desc: PatternDesc
  /** The pattern's source text, used in R014/R015 messages. */
  readonly text: string
  /** Number of values pushed on a successful match. */
  readonly bindCount: number
}

export function isFunctionProto(c: Constant | undefined): c is FunctionProto {
  return typeof c === 'object' && c !== null && c.tag === 'proto'
}

export function isPatternConst(c: Constant | undefined): c is PatternConst {
  return typeof c === 'object' && c !== null && c.tag === 'pattern'
}

// ---------------------------------------------------------------------------------------------
// Functions and programs

export type LocalKind = 'let' | 'var' | 'param' | 'fn' | 'loop' | 'match' | 'hidden'

export interface LocalInfo {
  readonly name: string
  /** Stack slot relative to the frame base (slot 0 is the callee). */
  readonly slot: number
  /** First ip at which the local holds its value. */
  readonly startIp: number
  /** First ip at which the local no longer exists (exclusive). */
  readonly endIp: number
  readonly mutable: boolean
  /** Compiler temporaries such as `$iter` and `$subject`; names start with `$`. */
  readonly hidden: boolean
  readonly kind: LocalKind
  readonly declSpan: Span
}

export interface DebugInfo {
  readonly source: 'main' | 'prelude'
  /** True for library (prelude) code, which debuggers may skip. */
  readonly library: boolean
  /** The whole function (or the whole program for the script). */
  readonly span: Span
  /** Per code index: the responsible AST node's span (operand indices repeat their instruction). */
  readonly spanStart: Int32Array
  readonly spanEnd: Int32Array
  /** Per code index: 1 where an instruction begins a step-over-able unit (ARCHITECTURE §4.3.5). */
  readonly stmtStart: Uint8Array
  /** Per code index: the innermost enclosing statement's span. */
  readonly stmtSpanStart: Int32Array
  readonly stmtSpanEnd: Int32Array
  readonly locals: readonly LocalInfo[]
  readonly upvalueNames: readonly string[]
}

export interface FunctionProto {
  readonly tag: 'proto'
  /** Unique across the library and the program; index into the combined proto table. */
  readonly id: number
  /** Display name (SPEC §7.12); null for unnamed functions; `'<top level>'` for the script. */
  readonly name: string | null
  readonly kind: 'script' | 'function'
  readonly arity: number
  readonly code: readonly number[]
  readonly constants: readonly Constant[]
  readonly upvalueCount: number
  readonly debug: DebugInfo
}

export interface GlobalInfo {
  readonly name: string
  readonly kind: 'let' | 'var' | 'fn'
  readonly mutable: boolean
  readonly declSpan: Span
}

export interface Program {
  readonly source: string
  readonly script: FunctionProto
  /** Every proto of this program ordered by id: `protos[i].id === firstProtoId + i`. */
  readonly protos: readonly FunctionProto[]
  readonly firstProtoId: number
  /** Top-level declarations in declaration order. */
  readonly globals: readonly GlobalInfo[]
  /** Non-fatal diagnostics (warnings). */
  readonly diagnostics: readonly Diagnostic[]
}

/** Display name of a function for messages: its name, or `lambda` when unnamed (SPEC §11.2 R005). */
export function functionDisplayName(proto: FunctionProto): string {
  return proto.name ?? 'lambda'
}
