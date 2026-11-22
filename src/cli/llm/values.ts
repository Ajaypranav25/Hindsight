/**
 * A model's predicted value, made real and compared (ARCHITECTURE §9.2). The prediction is
 * Hindsight text; it is never trusted as text: it must be one expression, and it is compiled and
 * run in the VM under a small step budget (no host access, nothing but its own result). The value
 * it produces is then compared with the recorded one by the language's equality (SPEC §7.4), with
 * a small tolerance for numbers, walking both values through the public Recording API with an
 * explicit work stack.
 */
import { compile, parse, record, type Recording, type ValueView } from '../../core/index'
import { deepText } from '../../core/call-values'

/** The longest prediction evaluated, in characters. */
export const MAX_PREDICTION_LENGTH = 20_000
/** Steps a prediction may take to evaluate (literals take a handful). */
export const PREDICTION_STEPS = 100_000
/** Numbers within this relative distance count as equal (floating-point noise, not a bug). */
export const RELATIVE_TOLERANCE = 1e-9
/** And within this absolute distance, for results near zero. */
export const ABSOLUTE_TOLERANCE = 1e-12
/** The most value pairs compared before giving up ("cannot tell"). */
export const MAX_COMPARED = 20_000
const PAGE = 200
const TEXT_LIMIT = 2_000
const BINDING = 'expected'

/** A value as the Recording API shows it, at a time of a recording. */
export interface ValueAt {
  readonly recording: Recording
  readonly time: number
  readonly value: ValueView
}

export type Prediction =
  | { readonly ok: true; readonly at: ValueAt; readonly text: string }
  | { readonly ok: false; readonly error: string }

/** Whether `text` is exactly one expression (not statements, not a declaration). */
function isOneExpression(text: string): boolean {
  const parsed = parse(`(${text})`)
  const [statement, extra] = parsed.program.body
  return parsed.diagnostics.length === 0 && statement?.kind === 'ExprStmt' && extra === undefined
}

/** Evaluates a predicted value in the VM; its value, or why it is not one. */
export function evaluatePrediction(given: string): Prediction {
  const text = given.trim()
  if (text === '') return { ok: false, error: 'it is empty' }
  if (text.length > MAX_PREDICTION_LENGTH) return { ok: false, error: 'it is too long' }
  if (!isOneExpression(text)) return { ok: false, error: 'it is not one Hindsight expression' }
  const compiled = compile(`let ${BINDING} = (${text})\n`)
  if (!compiled.ok) {
    return { ok: false, error: compiled.diagnostics[0]?.message ?? 'it does not compile' }
  }
  const recording = record(compiled.program, { maxSteps: PREDICTION_STEPS })
  const { outcome } = recording
  if (outcome.kind === 'error') return { ok: false, error: outcome.error.message }
  if (outcome.kind !== 'finished') return { ok: false, error: 'it takes too long to evaluate' }
  const time = recording.length
  const global = recording.stateAt(time).globals.find((candidate) => candidate.name === BINDING)
  if (global === undefined) return { ok: false, error: 'it has no value' }
  const at = { recording, time, value: global.value }
  return { ok: true, at, text: displayText(at) }
}

/** A value as `repr` shows it, cut to a readable length. */
export function displayText(at: ValueAt): string {
  return deepText(at.recording, at.time, at.value, 'display', TEXT_LIMIT)?.text ?? '?'
}

export type Comparison = 'equal' | 'different' | 'unknown'

function closeNumbers(a: number, b: number): boolean {
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const distance = Math.abs(a - b)
  return (
    distance <= ABSOLUTE_TOLERANCE ||
    distance <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b))
  )
}

interface Pair {
  readonly a: ValueView
  readonly b: ValueView
}

type ListObject = { readonly items: readonly ValueView[]; readonly length: number }
type RecordEntries = ReadonlyMap<string, ValueView>

/**
 * Compares two values by language equality, numbers within the tolerance. "unknown" when a part
 * cannot be compared across two runs (functions, iterators) or the values are too large.
 */
export function compareValues(left: ValueAt, right: ValueAt): Comparison {
  return new Comparer(left, right).run()
}

class Comparer {
  private readonly work: Pair[]
  private readonly seen = new Set<string>()
  private compared = 0
  private unknown = false

  constructor(
    private readonly left: ValueAt,
    private readonly right: ValueAt,
  ) {
    this.work = [{ a: left.value, b: right.value }]
  }

  run(): Comparison {
    while (this.work.length > 0) {
      if (++this.compared > MAX_COMPARED) return 'unknown'
      const { a, b } = this.work.pop()!
      if (!this.pair(a, b)) return 'different'
    }
    return this.unknown ? 'unknown' : 'equal'
  }

  /** Checks one pair, queueing the pairs inside it; false when they differ. */
  private pair(a: ValueView, b: ValueView): boolean {
    if (a.kind === 'number' && b.kind === 'number') return closeNumbers(a.value, b.value)
    if (a.kind !== 'ref' || b.kind !== 'ref') {
      if (a.kind !== b.kind) return false
      return a.kind === 'nil' || (a as { value: unknown }).value === (b as { value: unknown }).value
    }
    if (a.type !== b.type) return false
    // A pair already being compared counts as equal (cyclic values, SPEC §7.4).
    const key = `${a.id}:${b.id}`
    if (this.seen.has(key)) return true
    this.seen.add(key)
    switch (a.type) {
      case 'list':
        return this.lists(a.id, b.id)
      case 'record':
        return this.records(a.id, b.id)
      case 'range':
        return this.ranges(a.id, b.id)
      default:
        this.unknown = true
        return true
    }
  }

  private list(at: ValueAt, id: number, offset: number): ListObject | null {
    const object = at.recording.objectAt(at.time, id, { offset, limit: PAGE })
    return object?.type === 'list' ? object : null
  }

  private lists(aId: number, bId: number): boolean {
    let offset = 0
    let a = this.list(this.left, aId, 0)
    let b = this.list(this.right, bId, 0)
    if (a === null || b === null) return this.cannotTell()
    if (a.length !== b.length) return false
    while (a !== null && b !== null && offset < a.length) {
      for (let i = 0; i < a.items.length && i < b.items.length; i++) {
        this.work.push({ a: a.items[i]!, b: b.items[i]! })
      }
      offset += PAGE
      if (offset >= a.length || this.work.length > MAX_COMPARED) break
      a = this.list(this.left, aId, offset)
      b = this.list(this.right, bId, offset)
    }
    return true
  }

  private entries(at: ValueAt, id: number): RecordEntries | null {
    const entries = new Map<string, ValueView>()
    let offset = 0
    for (;;) {
      const object = at.recording.objectAt(at.time, id, { offset, limit: PAGE })
      if (object?.type !== 'record') return null
      for (const entry of object.entries) entries.set(entry.key, entry.value)
      offset += PAGE
      if (offset >= object.length || entries.size > MAX_COMPARED) return entries
    }
  }

  private records(aId: number, bId: number): boolean {
    const a = this.entries(this.left, aId)
    const b = this.entries(this.right, bId)
    if (a === null || b === null) return this.cannotTell()
    if (a.size !== b.size) return false
    for (const [key, value] of a) {
      const other = b.get(key)
      if (other === undefined) return false
      this.work.push({ a: value, b: other })
    }
    return true
  }

  private ranges(aId: number, bId: number): boolean {
    const a = this.left.recording.objectAt(this.left.time, aId)
    const b = this.right.recording.objectAt(this.right.time, bId)
    if (a?.type !== 'range' || b?.type !== 'range') return this.cannotTell()
    return (
      a.start === b.start && a.end === b.end && a.step === b.step && a.inclusive === b.inclusive
    )
  }

  private cannotTell(): boolean {
    this.unknown = true
    return true
  }
}
