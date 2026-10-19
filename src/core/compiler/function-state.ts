/**
 * Per-function compilation state (ARCHITECTURE §4.3): code under construction, constants, debug
 * tables, the tracked stack depth, scopes, upvalues and loop contexts. Deliberately imperative.
 */
import type { Constant, FunctionProto, LocalInfo, LocalKind, OpCode } from '../bytecode'
import { Op } from '../bytecode'
import type { Span } from '../span'
import type { CompileContext } from './context'
import { buildDebugInfo } from './debug-info'
import { stackEffect } from './stack-effects'

/** A declared local of the function being compiled. */
export interface Binding {
  readonly name: string
  readonly slot: number
  readonly kind: LocalKind
  readonly mutable: boolean
  readonly declSpan: Span
  /** Live-range start; filled in after the binding becomes visible for a local `fn`. */
  startIp: number
}

export interface Scope {
  readonly startDepth: number
  readonly bindings: Binding[]
}

export interface LoopContext {
  readonly bodyDepth: number
  readonly continueTarget: number
  /** Operand indices of `break` jumps, patched to the loop exit. */
  readonly breakJumps: number[]
}

export interface Upvalue {
  readonly isLocal: boolean
  readonly index: number
  readonly name: string
  readonly binding: Binding
}

export interface FunctionSetup {
  readonly name: string | null
  readonly kind: 'script' | 'function'
  readonly arity: number
  readonly span: Span
  /** Statement span of instructions outside every statement (such as the implicit return). */
  readonly baseStmtSpan: Span
}

export type BlockMode = 'value' | 'stmt'

export class FunctionState {
  readonly id: number
  readonly code: number[] = []
  readonly constants: Constant[] = []
  readonly spanStart: number[] = []
  readonly spanEnd: number[] = []
  readonly stmtStart: number[] = []
  readonly stmtSpanStart: number[] = []
  readonly stmtSpanEnd: number[] = []
  readonly scopes: Scope[] = []
  readonly locals: LocalInfo[] = []
  readonly upvalues: Upvalue[] = []
  readonly loops: LoopContext[] = []
  depth: number
  stmtSpan: Span
  private pendingStmtStart = false
  private readonly constantIndex = new Map<string, number>()

  constructor(
    readonly ctx: CompileContext,
    readonly enclosing: FunctionState | null,
    readonly setup: FunctionSetup,
  ) {
    this.id = ctx.reserveProtoId()
    this.depth = 1 + setup.arity
    this.stmtSpan = setup.baseStmtSpan
  }

  get ip(): number {
    return this.code.length
  }

  get isScript(): boolean {
    return this.setup.kind === 'script'
  }

  /** True directly at program top level, where declarations create globals (SPEC §5.2). */
  get atTopLevel(): boolean {
    return this.isScript && this.scopes.length === 0
  }

  // -- emission ------------------------------------------------------------------------------

  /** Appends an instruction, records its debug info and applies its fall-through stack effect. */
  emit(op: OpCode, operands: readonly number[], span: Span): number {
    const ip = this.code.length
    this.code.push(op, ...operands)
    for (let i = ip; i < this.code.length; i++) {
      this.spanStart.push(span.start)
      this.spanEnd.push(span.end)
      this.stmtStart.push(i === ip && this.pendingStmtStart ? 1 : 0)
      this.stmtSpanStart.push(this.stmtSpan.start)
      this.stmtSpanEnd.push(this.stmtSpan.end)
    }
    this.pendingStmtStart = false
    const effect = stackEffect(this.code, ip, this.constants)
    this.depth += effect.pushes - effect.pops
    return ip
  }

  /** Emits a jump whose target (its last operand) is patched later; returns the operand index. */
  emitJump(op: OpCode, span: Span, leading: readonly number[] = []): number {
    this.emit(op, [...leading, -1], span)
    return this.code.length - 1
  }

  patchJump(operandIndex: number, target: number = this.ip): void {
    this.code[operandIndex] = target
  }

  /** Marks the next emitted instruction as a statement start (ARCHITECTURE §4.3.5). */
  markStmtStart(): void {
    this.pendingStmtStart = true
  }

  clearStmtStart(): void {
    this.pendingStmtStart = false
  }

  /** Runs `body` with `span` as the innermost statement span. */
  withStmtSpan(span: Span, body: () => void): void {
    const saved = this.stmtSpan
    this.stmtSpan = span
    body()
    this.stmtSpan = saved
  }

  // -- constants -----------------------------------------------------------------------------

  /** Index of a number or string constant; equal values share one entry. */
  constantFor(value: number | string): number {
    const key = typeof value === 'string' ? `s${value}` : Object.is(value, -0) ? 'n-0' : `n${value}`
    const existing = this.constantIndex.get(key)
    if (existing !== undefined) return existing
    const index = this.addConstant(value)
    this.constantIndex.set(key, index)
    return index
  }

  addConstant(constant: Constant): number {
    this.constants.push(constant)
    return this.constants.length - 1
  }

  // -- scopes and locals ---------------------------------------------------------------------

  pushScope(startDepth: number = this.depth): Scope {
    const scope: Scope = { startDepth, bindings: [] }
    this.scopes.push(scope)
    return scope
  }

  /** Makes a binding visible in the innermost scope. */
  declare(binding: Binding): Binding {
    this.scopes[this.scopes.length - 1]!.bindings.push(binding)
    return binding
  }

  /**
   * Closes the innermost scope with `EndScope` (value mode) or `PopN` (statement mode), operand
   * computed from depths, and ends its bindings' live ranges just after that instruction.
   */
  closeScope(mode: BlockMode, span: Span): Binding[] {
    const scope = this.scopes.pop()!
    const count = this.depth - scope.startDepth - (mode === 'value' ? 1 : 0)
    if (count > 0) this.emit(mode === 'value' ? Op.EndScope : Op.PopN, [count], span)
    for (const binding of scope.bindings) this.recordLocal(binding, binding.startIp, this.ip)
    return scope.bindings
  }

  recordLocal(binding: Binding, startIp: number, endIp: number, hidden = false): void {
    this.locals.push({
      name: binding.name,
      slot: binding.slot,
      startIp,
      endIp,
      mutable: binding.mutable,
      hidden,
      kind: binding.kind,
      declSpan: binding.declSpan,
    })
  }

  addUpvalue(isLocal: boolean, index: number, binding: Binding): number {
    const existing = this.upvalues.findIndex((u) => u.isLocal === isLocal && u.index === index)
    if (existing >= 0) return existing
    this.upvalues.push({ isLocal, index, name: binding.name, binding })
    return this.upvalues.length - 1
  }

  /** Ends the remaining (parameter) scopes at the end of the code and stores the proto. */
  finish(): FunctionProto {
    while (this.scopes.length > 0) {
      const scope = this.scopes.pop()!
      for (const binding of scope.bindings) this.recordLocal(binding, binding.startIp, this.ip)
    }
    const proto: FunctionProto = {
      tag: 'proto',
      id: this.id,
      name: this.setup.name,
      kind: this.setup.kind,
      arity: this.setup.arity,
      code: this.code,
      constants: this.constants,
      upvalueCount: this.upvalues.length,
      debug: buildDebugInfo(this),
    }
    this.ctx.storeProto(proto)
    return proto
  }
}
