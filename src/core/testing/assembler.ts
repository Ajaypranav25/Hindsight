/**
 * A small text assembler for tests: builds `Program`s and `FunctionProto`s without the compiler.
 *
 * Syntax (one item per line; `;` starts a comment outside strings and JSON):
 *
 *   Const 42                 instruction: mnemonic from `Op`, then operands
 *   @loop:                   label definition (labels are local to their function)
 *   .fn NAME arity=2 upvalues=1 [anon] [library]
 *     ...                    a function; nest `.fn` blocks freely; `anon` gives it the display
 *   .end                     name null (NAME is still its label); `library` marks it as prelude code
 *
 * Operands, by opcode:
 *   Const                    a number (`1.5`, `-3`, `NaN`, `Infinity`, `-Infinity`) or a JSON string
 *   GetGlobal SetGlobal DefineGlobal GetField SetField
 *                            a name, bare (`x`) or as a JSON string (`"x y"`)
 *   GetBuiltin DefineBuiltin a builtin name (`print`) or its index
 *   Jump JumpIfFalse AndJump OrJump IterNext
 *                            a label (`@loop`) or an absolute code index
 *   Closure NAME (local N | upvalue N)…
 *                            NAME is a `.fn` label anywhere in the file; one capture per upvalue
 *   Destructure PATTERN      PATTERN is JSON: a PatternDesc, or `{"desc": …, "text": "…"}`;
 *   MatchPattern PATTERN @l  bindCount is computed; text defaults to `<pattern>`
 *   anything else            plain integers
 *   `#N` anywhere            the raw operand N (escape hatch, e.g. `Const #0` for constant 0)
 *
 * Debug directives (they apply to the function being assembled):
 *   .span S E                span of the following instructions (sticky; default 0 0)
 *   .stmt S E                statement span of the following instructions (sticky; default 0 0)
 *   .start                   marks the next instruction as a statement start
 *   .local NAME slot=N start=@l|N end=@l|N [kind=let] [mutable] [hidden] [decl=S:E]
 *   .upname NAME             appends an upvalue name
 *   .fnspan S E              the function's own span
 *
 * Program-level directives (outside every `.fn`):
 *   .global NAME KIND        adds a GlobalInfo (KIND: let, var or fn; var is mutable)
 *
 * Protos are numbered from `firstProtoId`: the script first, then `.fn` blocks in the order their
 * `.fn` lines appear.
 */
import {
  type Constant,
  type FunctionProto,
  type GlobalInfo,
  type LocalInfo,
  type LocalKind,
  OPERAND_COUNTS,
  Op,
  type OpName,
  type PatternConst,
  type PatternDesc,
  type Program,
} from '../bytecode'
import { builtinIndex } from '../builtin-names'
import type { Span } from '../span'
import { tokenizeLine } from './assembler-tokens'

export interface AssembleOptions {
  readonly source?: string
  readonly firstProtoId?: number
}

/** Assembles `text` into a Program. Throws an Error naming the line for any malformed input. */
export function assemble(text: string, options: AssembleOptions = {}): Program {
  return new Assembler(options).run(text)
}

const LABEL_OPS = new Set<number>([Op.Jump, Op.JumpIfFalse, Op.AndJump, Op.OrJump, Op.IterNext])
const NAME_OPS = new Set<number>([
  Op.GetGlobal,
  Op.SetGlobal,
  Op.DefineGlobal,
  Op.GetField,
  Op.SetField,
])

interface Fixup {
  readonly at: number
  readonly label: string
  readonly line: number
}

interface PendingLocal {
  readonly name: string
  readonly slot: number
  readonly start: string
  readonly end: string
  readonly kind: LocalKind
  readonly mutable: boolean
  readonly hidden: boolean
  readonly declSpan: Span
  readonly line: number
}

interface ProtoReference {
  readonly owner: FunctionBuilder
  readonly constantIndex: number
  readonly name: string
  readonly line: number
}

class FunctionBuilder {
  readonly code: number[] = []
  readonly constants: Constant[] = []
  readonly labels = new Map<string, number>()
  readonly fixups: Fixup[] = []
  readonly locals: PendingLocal[] = []
  readonly upvalueNames: string[] = []
  readonly spanStart: number[] = []
  readonly spanEnd: number[] = []
  readonly stmtStart: number[] = []
  readonly stmtSpanStart: number[] = []
  readonly stmtSpanEnd: number[] = []
  span: Span = { start: 0, end: 0 }
  stmtSpan: Span = { start: 0, end: 0 }
  fnSpan: Span = { start: 0, end: 0 }
  markStart = false
  /** Filled in by `finish`. */
  proto: FunctionProto | null = null

  constructor(
    readonly id: number,
    readonly label: string,
    readonly displayName: string | null,
    readonly kind: 'script' | 'function',
    readonly arity: number,
    readonly upvalueCount: number,
    readonly library: boolean,
  ) {}

  /** Interns a number or string constant (`Object.is` equality, so `-0` and `0` differ). */
  constant(value: number | string): number {
    const existing = this.constants.findIndex((c) => Object.is(c, value))
    if (existing !== -1) return existing
    this.constants.push(value)
    return this.constants.length - 1
  }

  /** Appends one instruction's code elements with the current debug state. */
  emit(elements: readonly number[]): void {
    elements.forEach((element, i) => {
      this.code.push(element)
      this.spanStart.push(this.span.start)
      this.spanEnd.push(this.span.end)
      this.stmtSpanStart.push(this.stmtSpan.start)
      this.stmtSpanEnd.push(this.stmtSpan.end)
      this.stmtStart.push(i === 0 && this.markStart ? 1 : 0)
    })
    this.markStart = false
  }
}

class Assembler {
  private readonly builders: FunctionBuilder[] = []
  private readonly byLabel = new Map<string, FunctionBuilder>()
  private readonly open: FunctionBuilder[] = []
  private readonly references: ProtoReference[] = []
  private readonly globals: GlobalInfo[] = []
  private readonly firstProtoId: number
  private lineNumber = 0

  constructor(private readonly options: AssembleOptions) {
    this.firstProtoId = options.firstProtoId ?? 0
  }

  run(text: string): Program {
    const script = this.startFunction('<top level>', '<top level>', 'script', 0, 0, false)
    this.open.push(script)
    text.split(/\r\n|\r|\n/).forEach((line, index) => {
      this.lineNumber = index + 1
      this.line(tokenizeLine(line, this.lineNumber))
    })
    if (this.open.length !== 1) this.fail('missing .end')
    return this.finish()
  }

  private get current(): FunctionBuilder {
    return this.open[this.open.length - 1]!
  }

  private fail(message: string, line = this.lineNumber): never {
    throw new Error(`assembler line ${line}: ${message}`)
  }

  private line(tokens: string[]): void {
    const head = tokens[0]
    if (head === undefined) return
    if (head.startsWith('@') && head.endsWith(':')) {
      this.defineLabel(head.slice(1, -1), tokens.slice(1))
    } else if (head.startsWith('.')) {
      this.directive(head, tokens.slice(1))
    } else {
      this.instruction(head, tokens.slice(1))
    }
  }

  private defineLabel(label: string, rest: string[]): void {
    if (this.current.labels.has(label)) this.fail(`duplicate label @${label}`)
    this.current.labels.set(label, this.current.code.length)
    if (rest.length > 0) this.line(rest)
  }

  // -------------------------------------------------------------------------------------------
  // Directives

  private directive(name: string, args: string[]): void {
    const fn = this.current
    switch (name) {
      case '.fn':
        this.openFunction(args)
        return
      case '.end':
        if (this.open.length === 1) this.fail('.end without .fn')
        this.open.pop()
        return
      case '.span':
        fn.span = this.spanArgs(args)
        return
      case '.stmt':
        fn.stmtSpan = this.spanArgs(args)
        return
      case '.fnspan':
        fn.fnSpan = this.spanArgs(args)
        return
      case '.start':
        fn.markStart = true
        return
      case '.upname':
        fn.upvalueNames.push(this.required(args, 0, 'a name'))
        return
      case '.local':
        fn.locals.push(this.localArgs(args))
        return
      case '.global':
        this.globalArgs(args)
        return
      default:
        this.fail(`unknown directive ${name}`)
    }
  }

  private openFunction(args: string[]): void {
    const label = this.required(args, 0, 'a function name')
    const flags = this.flags(args.slice(1))
    const name = flags.has('anon') ? null : label
    const arity = this.integer(flags.get('arity') ?? '0')
    const upvalues = this.integer(flags.get('upvalues') ?? '0')
    const library = flags.has('library')
    if (this.byLabel.has(label)) this.fail(`duplicate function ${label}`)
    const builder = this.startFunction(label, name, 'function', arity, upvalues, library)
    this.open.push(builder)
  }

  private startFunction(
    label: string,
    name: string | null,
    kind: 'script' | 'function',
    arity: number,
    upvalues: number,
    library: boolean,
  ): FunctionBuilder {
    const id = this.firstProtoId + this.builders.length
    const builder = new FunctionBuilder(id, label, name, kind, arity, upvalues, library)
    this.builders.push(builder)
    this.byLabel.set(label, builder)
    return builder
  }

  private localArgs(args: string[]): PendingLocal {
    const name = this.required(args, 0, 'a local name')
    const flags = this.flags(args.slice(1))
    const decl = (flags.get('decl') ?? '0:0').split(':')
    return {
      name,
      slot: this.integer(flags.get('slot') ?? this.fail('.local needs slot=N')),
      start: flags.get('start') ?? '0',
      end: flags.get('end') ?? this.fail('.local needs end=…'),
      kind: (flags.get('kind') ?? 'let') as LocalKind,
      mutable: flags.has('mutable'),
      hidden: flags.has('hidden'),
      declSpan: { start: this.integer(decl[0] ?? '0'), end: this.integer(decl[1] ?? '0') },
      line: this.lineNumber,
    }
  }

  private globalArgs(args: string[]): void {
    if (this.open.length !== 1) this.fail('.global inside .fn')
    const name = this.required(args, 0, 'a global name')
    const kind = this.required(args, 1, 'a kind') as GlobalInfo['kind']
    if (kind !== 'let' && kind !== 'var' && kind !== 'fn') this.fail(`bad global kind ${kind}`)
    this.globals.push({ name, kind, mutable: kind === 'var', declSpan: { start: 0, end: 0 } })
  }

  /** `key=value` pairs and bare flags. */
  private flags(args: string[]): Map<string, string> {
    const flags = new Map<string, string>()
    for (const arg of args) {
      const eq = arg.indexOf('=')
      if (eq === -1) flags.set(arg, '')
      else flags.set(arg.slice(0, eq), arg.slice(eq + 1))
    }
    return flags
  }

  private spanArgs(args: string[]): Span {
    return { start: this.integer(args[0] ?? ''), end: this.integer(args[1] ?? '') }
  }

  private required(args: string[], index: number, what: string): string {
    return args[index] ?? this.fail(`expected ${what}`)
  }

  private integer(text: string): number {
    const value = Number(text)
    if (text === '' || !Number.isInteger(value)) this.fail(`expected an integer, got '${text}'`)
    return value
  }

  // -------------------------------------------------------------------------------------------
  // Instructions

  private instruction(mnemonic: string, operands: string[]): void {
    if (!(mnemonic in Op)) this.fail(`unknown instruction ${mnemonic}`)
    const op = Op[mnemonic as OpName]
    const fn = this.current
    const start = fn.code.length
    const elements = [op as number, ...this.operands(op, operands, start)]
    const expected = OPERAND_COUNTS[op]!
    if (op !== Op.Closure && elements.length - 1 !== expected) {
      this.fail(`${mnemonic} takes ${expected} operand(s), got ${elements.length - 1}`)
    }
    fn.emit(elements)
  }

  private operands(op: number, operands: string[], start: number): number[] {
    const raw = (text: string): number | null =>
      text.startsWith('#') ? this.integer(text.slice(1)) : null
    if (op === Op.Closure) return this.closureOperands(operands)
    if (op === Op.Destructure) return [this.patternOperand(this.required(operands, 0, 'a pattern'))]
    if (op === Op.MatchPattern) {
      const pattern = this.patternOperand(this.required(operands, 0, 'a pattern'))
      return [pattern, this.jumpOperand(this.required(operands, 1, 'a target'), start + 2)]
    }
    return operands.map((text, i) => {
      const value = raw(text)
      if (value !== null) return value
      if (op === Op.Const) return this.current.constant(this.constantValue(text))
      if (NAME_OPS.has(op)) return this.current.constant(this.name(text))
      if (op === Op.GetBuiltin || op === Op.DefineBuiltin) return this.builtin(text)
      if (LABEL_OPS.has(op)) return this.jumpOperand(text, start + 1 + i)
      return this.integer(text)
    })
  }

  private constantValue(text: string): number | string {
    if (text.startsWith('"')) return JSON.parse(text) as string
    if (text === 'NaN') return NaN
    const value = Number(text)
    if (text === '' || (Number.isNaN(value) && text !== 'NaN')) this.fail(`bad constant ${text}`)
    return value
  }

  private name(text: string): string {
    return text.startsWith('"') ? (JSON.parse(text) as string) : text
  }

  private builtin(text: string): number {
    if (/^-?\d+$/.test(text)) return Number(text)
    const index = builtinIndex(text)
    if (index === -1) this.fail(`unknown builtin ${text}`)
    return index
  }

  private jumpOperand(text: string, at: number): number {
    if (!text.startsWith('@')) return this.integer(text)
    this.current.fixups.push({ at, label: text.slice(1), line: this.lineNumber })
    return -1
  }

  private closureOperands(operands: string[]): number[] {
    const name = this.required(operands, 0, 'a function name')
    const fn = this.current
    // A placeholder constant (an object, so `constant` never interns it), replaced in `finish`.
    fn.constants.push({ tag: 'pattern', desc: { t: 'any' }, text: '', bindCount: 0 })
    const constantIndex = fn.constants.length - 1
    this.references.push({ owner: fn, constantIndex, name, line: this.lineNumber })
    const result = [constantIndex]
    for (let i = 1; i < operands.length; i += 2) {
      const where = operands[i]
      if (where !== 'local' && where !== 'upvalue') this.fail(`expected local or upvalue`)
      result.push(where === 'local' ? 1 : 0, this.integer(operands[i + 1] ?? ''))
    }
    return result
  }

  private patternOperand(json: string): number {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      this.fail(`bad pattern JSON ${json}`)
    }
    const record = parsed as { desc?: PatternDesc; text?: string }
    const desc = record.desc ?? (parsed as PatternDesc)
    const pattern: PatternConst = {
      tag: 'pattern',
      desc,
      text: record.text ?? '<pattern>',
      bindCount: bindCount(desc),
    }
    this.current.constants.push(pattern)
    return this.current.constants.length - 1
  }

  // -------------------------------------------------------------------------------------------
  // Finishing

  private finish(): Program {
    for (const builder of this.builders) this.resolveLabels(builder)
    for (const builder of this.builders) this.finishProto(builder)
    // Protos share their builder's constants array, so Closure placeholders can be patched after
    // every proto exists (this also allows a function to reference itself).
    for (const reference of this.references) {
      const child = this.byLabel.get(reference.name)
      if (child?.proto == null) this.fail(`unknown function ${reference.name}`, reference.line)
      reference.owner.constants[reference.constantIndex] = child.proto
    }
    const protos = this.builders.map((builder) => builder.proto!)
    return {
      source: this.options.source ?? '',
      script: protos[0]!,
      protos,
      firstProtoId: this.firstProtoId,
      globals: this.globals,
      diagnostics: [],
    }
  }

  private resolveLabels(builder: FunctionBuilder): void {
    for (const fixup of builder.fixups) {
      const target = builder.labels.get(fixup.label)
      if (target === undefined) this.fail(`unknown label @${fixup.label}`, fixup.line)
      builder.code[fixup.at] = target
    }
  }

  private resolveLocalBound(builder: FunctionBuilder, text: string, line: number): number {
    if (!text.startsWith('@')) return Number(text)
    const target = builder.labels.get(text.slice(1))
    return target ?? this.fail(`unknown label ${text}`, line)
  }

  private finishProto(builder: FunctionBuilder): void {
    const locals: LocalInfo[] = builder.locals.map((local) => ({
      name: local.name,
      slot: local.slot,
      startIp: this.resolveLocalBound(builder, local.start, local.line),
      endIp: this.resolveLocalBound(builder, local.end, local.line),
      mutable: local.mutable,
      hidden: local.hidden,
      kind: local.kind,
      declSpan: local.declSpan,
    }))
    builder.proto = {
      tag: 'proto',
      id: builder.id,
      name: builder.displayName,
      kind: builder.kind,
      arity: builder.arity,
      code: builder.code,
      constants: builder.constants,
      upvalueCount: builder.upvalueCount,
      debug: {
        source: builder.library ? 'prelude' : 'main',
        library: builder.library,
        span: builder.fnSpan,
        spanStart: Int32Array.from(builder.spanStart),
        spanEnd: Int32Array.from(builder.spanEnd),
        stmtStart: Uint8Array.from(builder.stmtStart),
        stmtSpanStart: Int32Array.from(builder.stmtSpanStart),
        stmtSpanEnd: Int32Array.from(builder.stmtSpanEnd),
        locals,
        upvalueNames: builder.upvalueNames,
      },
    }
  }
}

/** Number of values a successful match pushes (SPEC §6.2). */
export function bindCount(desc: PatternDesc): number {
  let count = 0
  const work: PatternDesc[] = [desc]
  while (work.length > 0) {
    const next = work.pop()!
    switch (next.t) {
      case 'bind':
        count++
        break
      case 'list':
        if (next.rest === 'bind') count++
        work.push(...next.before, ...next.after)
        break
      case 'record':
        for (const field of next.fields) work.push(field.pattern)
        break
      case 'or':
        break
      default:
        break
    }
  }
  return count
}
