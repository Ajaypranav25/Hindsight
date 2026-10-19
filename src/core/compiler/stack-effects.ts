/**
 * Stack effects of every instruction (ARCHITECTURE §5.2), shared by the compiler's depth tracking
 * and the bytecode verifier.
 */
import { type Constant, isPatternConst, Op } from '../bytecode'

export interface StackEffect {
  /** Values the instruction needs (and removes) on the stack. */
  readonly pops: number
  /** Values it leaves on the fall-through path. */
  readonly pushes: number
  /** Depth change on the jump path relative to the depth before the instruction, or null. */
  readonly jumpDelta: number | null
  /** False for terminators (`Jump`, `Return`, `NoMatch`). */
  readonly fallsThrough: boolean
}

const PUSH_ONE = new Set<number>([
  Op.Const,
  Op.Nil,
  Op.True,
  Op.False,
  Op.GetLocal,
  Op.GetUpvalue,
  Op.GetGlobal,
  Op.GetBuiltin,
  Op.Closure,
])

const POP_ONE = new Set<number>([
  Op.Pop,
  Op.SetLocal,
  Op.SetUpvalue,
  Op.SetGlobal,
  Op.DefineGlobal,
  Op.DefineBuiltin,
])

const BINARY = new Set<number>([
  Op.Add,
  Op.Sub,
  Op.Mul,
  Op.Div,
  Op.Mod,
  Op.Pow,
  Op.Eq,
  Op.Ne,
  Op.Lt,
  Op.Le,
  Op.Gt,
  Op.Ge,
  Op.Range,
  Op.GetIndex,
  Op.ListAppend,
  Op.ListExtend,
  Op.RecordMerge,
])

function plain(pops: number, pushes: number): StackEffect {
  return { pops, pushes, jumpDelta: null, fallsThrough: true }
}

function jumping(pops: number, pushes: number, jumpDelta: number): StackEffect {
  return { pops, pushes, jumpDelta, fallsThrough: true }
}

const TERMINATOR_POP: StackEffect = { pops: 1, pushes: 0, jumpDelta: null, fallsThrough: false }

/** Bind count of the pattern constant at `k`, or 0 when it is not a pattern. */
function bindCountAt(constants: readonly Constant[], k: number): number {
  const constant = constants[k]
  return isPatternConst(constant) ? constant.bindCount : 0
}

function operandEffect(op: number, n: number, constants: readonly Constant[]): StackEffect | null {
  switch (op) {
    case Op.PopN:
      return plain(n, 0)
    case Op.EndScope:
      return plain(n + 1, 1)
    case Op.Declare:
      return plain(n, n)
    case Op.Call:
      return plain(n + 1, 1)
    case Op.List:
    case Op.Interp:
      return plain(n, 1)
    case Op.Record:
      return plain(2 * n, 1)
    case Op.Destructure:
      return plain(1, bindCountAt(constants, n))
    case Op.MatchPattern:
      return jumping(1, 1 + bindCountAt(constants, n), 0)
    default:
      return null
  }
}

function fixedEffect(op: number): StackEffect {
  if (PUSH_ONE.has(op)) return plain(0, 1)
  if (POP_ONE.has(op)) return plain(1, 0)
  if (BINARY.has(op)) return plain(2, 1)
  switch (op) {
    case Op.Dup:
      return plain(1, 2)
    case Op.Dup2:
      return plain(2, 4)
    case Op.GetField:
    case Op.Neg:
    case Op.Not:
    case Op.IterInit:
      return plain(1, 1)
    case Op.SetField:
      return plain(2, 0)
    case Op.SetIndex:
      return plain(3, 0)
    case Op.RecordSet:
      return plain(3, 1)
    case Op.Jump:
      return { pops: 0, pushes: 0, jumpDelta: 0, fallsThrough: false }
    case Op.JumpIfFalse:
      return jumping(1, 0, -1)
    case Op.AndJump:
    case Op.OrJump:
      return jumping(1, 0, 0)
    case Op.IterNext:
      return jumping(1, 2, 0)
    case Op.Return:
    case Op.NoMatch:
      return TERMINATOR_POP
    default:
      return plain(0, 0)
  }
}

/**
 * The stack effect of the instruction at `ip`. `NoMatch` is modeled as needing the subject; it never
 * falls through. Unknown opcodes have no effect (the verifier reports them separately).
 */
export function stackEffect(
  code: readonly number[],
  ip: number,
  constants: readonly Constant[],
): StackEffect {
  const op = code[ip]!
  return operandEffect(op, code[ip + 1] ?? 0, constants) ?? fixedEffect(op)
}
