/**
 * Answers as assertions (ARCHITECTURE §7.6): every call a person judged right becomes
 * `assert(f(args) == result)`, written in Hindsight source. Added to the program, each one is an
 * example the contract oracle reads, so the same questions answer themselves on the next run.
 *
 * Only calls that can be replayed anywhere are offered: a function declared at the top level, whose
 * code reads no global other than functions, that changed nothing outside itself and whose
 * arguments and result are plain data (numbers, strings, booleans, nil, lists and records of those)
 * written in at most `MAX_TEXT` characters. Built only on the public `Recording` API.
 */
import type { Recording, ValueView } from './api-types'
import type * as ast from './ast'
import { instructionLength, Op, type FunctionProto } from './bytecode'
import type { FinderState } from './bug-finder'
import { changeTexts } from './bug-finder-text'
import { timeAfter } from './call-after'
import type { CallNode, CallTree } from './calls'
import { formatLiteral } from './literal'
import { parse } from './parser'
import { isKeyword } from './tokens'

/** The longest argument or result text an assertion is written with. */
const MAX_TEXT = 200
/** Lists and records nested deeper than this are not written out. */
const MAX_NESTING = 8
/** The most elements of one list or record written out. */
const MAX_ITEMS = 50

export interface AnswerAssertion {
  /** The call it stands for. */
  readonly call: CallNode
  /** `assert(total([88, 83, 79]) == 250)` */
  readonly text: string
}

/** The calls judged right by a person, written as assertions, without repeats, in answer order. */
export function answerAssertions(tree: CallTree, state: FinderState): AnswerAssertion[] {
  const recording = tree.recording
  const topLevel = topLevelFunctions(recording)
  const found: AnswerAssertion[] = []
  const seen = new Set<string>()
  for (const judgment of state.judgments) {
    if (judgment.answer !== 'right' || judgment.remembered || judgment.auto !== undefined) continue
    const text = assertionFor(tree, judgment.call, topLevel)
    if (text === null || seen.has(text)) continue
    seen.add(text)
    found.push({ call: judgment.call, text })
  }
  return found
}

/**
 * The source with `assertions` added after its last top-level function declaration (at the start
 * when it has none), so every function they call is defined and the rest of the program follows.
 */
export function insertAssertions(source: string, assertions: readonly string[]): string {
  if (assertions.length === 0) return source
  const { program } = parse(source)
  let at = 0
  for (const statement of program.body) {
    if (statement.kind === 'FnDecl') at = statement.span.end
  }
  const lineEnd = source.indexOf('\n', at)
  const cut = at === 0 ? 0 : lineEnd === -1 ? source.length : lineEnd + 1
  const before = source.slice(0, cut)
  const lead = before === '' || before.endsWith('\n') ? '' : '\n'
  const block = `${lead}${at === 0 ? '' : '\n'}${assertions.join('\n')}\n${at === 0 ? '\n' : ''}`
  return `${before}${block}${source.slice(cut)}`
}

const topLevelCache = new WeakMap<Recording, ReadonlyMap<string, ast.FunctionExpr>>()

/** The functions declared at the program's top level, by name. */
function topLevelFunctions(recording: Recording): ReadonlyMap<string, ast.FunctionExpr> {
  let functions = topLevelCache.get(recording)
  if (functions === undefined) {
    const map = new Map<string, ast.FunctionExpr>()
    for (const statement of parse(recording.program.source).program.body) {
      if (statement.kind === 'FnDecl') map.set(statement.name, statement.fn)
    }
    functions = map
    topLevelCache.set(recording, functions)
  }
  return functions
}

function assertionFor(
  tree: CallTree,
  call: CallNode,
  topLevel: ReadonlyMap<string, ast.FunctionExpr>,
): string | null {
  const recording = tree.recording
  if (call.depth === 0 || call.library || call.outcome !== 'returned') return null
  const proto = mainProto(recording, call.protoId)
  if (proto === null || proto.name === null) return null
  const declared = topLevel.get(proto.name)
  if (declared === undefined || declared.span.start !== proto.debug.span.start) return null
  if (!readsOnlyFunctions(recording, call, proto)) return null
  const details = tree.details(call)
  if (details.result === null || changeTexts(details).length > 0) return null
  const args: string[] = []
  for (const argument of details.args) {
    const text = sourceText(recording, call.entry, argument.value)
    if (text === null) return null
    args.push(text)
  }
  const result = sourceText(recording, timeAfter(call), details.result.value)
  if (result === null) return null
  return `assert(${proto.name}(${args.join(', ')}) == ${result})`
}

function mainProto(recording: Recording, protoId: number): FunctionProto | null {
  const { program } = recording
  const proto = program.protos[protoId - program.firstProtoId]
  return proto !== undefined && proto.debug.source === 'main' ? proto : null
}

/** Whether every global the function's code reads held a function when the call began. */
function readsOnlyFunctions(recording: Recording, call: CallNode, proto: FunctionProto): boolean {
  if (proto.upvalueCount > 0) return false
  const { code, constants } = proto
  const names = new Set<string>()
  for (let ip = 0; ip < code.length; ip += instructionLength(code, ip, constants)) {
    if (code[ip] === Op.GetGlobal) names.add(constants[code[ip + 1]!] as string)
  }
  if (names.size === 0) return true
  const globals = recording.stateAt(call.entry).globals
  for (const name of names) {
    const global = globals.find((candidate) => candidate.name === name)
    const value = global?.value
    if (value === undefined || value.kind !== 'ref' || value.type !== 'function') return false
  }
  return true
}

/** `value` as Hindsight source that evaluates to an equal value, or null when there is none. */
export function sourceText(recording: Recording, t: number, value: ValueView): string | null {
  const writer = new SourceWriter(recording, t)
  return writer.write(value, 0) ? writer.out : null
}

class SourceWriter {
  out = ''

  constructor(
    private readonly recording: Recording,
    private readonly t: number,
  ) {}

  /** Appends `value`; false when it is not plain data or the text grows too long. */
  write(value: ValueView, nesting: number): boolean {
    if (this.out.length > MAX_TEXT) return false
    switch (value.kind) {
      case 'nil':
        this.out += 'nil'
        return true
      case 'bool':
        this.out += String(value.value)
        return true
      case 'number':
        if (!Number.isFinite(value.value)) return false
        this.out += formatLiteral(value.value)
        return true
      case 'string':
        this.out += formatLiteral(value.value)
        return this.out.length <= MAX_TEXT
      case 'ref':
        return this.reference(value, nesting)
    }
  }

  private reference(value: ValueView & { kind: 'ref' }, nesting: number): boolean {
    if (nesting >= MAX_NESTING || (value.type !== 'list' && value.type !== 'record')) return false
    const object = this.recording.objectAt(this.t, value.id, { offset: 0, limit: MAX_ITEMS + 1 })
    if (object === null) return false
    if (object.type === 'list') {
      if (object.length > MAX_ITEMS) return false
      this.out += '['
      const done = object.items.every((item, i) => {
        if (i > 0) this.out += ', '
        return this.write(item, nesting + 1)
      })
      this.out += ']'
      return done
    }
    if (object.type !== 'record' || object.length > MAX_ITEMS) return false
    this.out += '{'
    const done = object.entries.every((entry, i) => {
      this.out += `${i > 0 ? ', ' : ''}${keyText(entry.key)}: `
      return this.write(entry.value, nesting + 1)
    })
    this.out += '}'
    return done
  }
}

/** A record key as a record literal writes it: bare when it is a name, else a string. */
function keyText(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !isKeyword(key) ? key : formatLiteral(key)
}
