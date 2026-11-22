/**
 * What a call was given and what it did, in a form two different programs can be compared by
 * (ARCHITECTURE §7.14). The bug finder's memo keys name functions by proto id, which differs
 * between two versions of a file, so these signatures are built from the same value texts
 * (`call-values.ts`) with function ids left out. A call's inputs are its arguments and the
 * captured variables and globals it reads; its behavior is its outcome, its result, what it did to
 * its arguments, its side effects (`call-effects.ts`) and the output printed while it ran.
 */
import type { OutputEvent, Recording, ValueView } from './api-types'
import { globalsReadBy } from './call-details'
import { timeAfter } from './call-after'
import type { CallNode, CallTree } from './calls'
import { deepText, KEY_TEXT_LIMIT, keyText, valueText } from './call-values'

export interface CallSignature {
  /** Argument texts at entry, in parameter order. */
  readonly args: readonly string[]
  /** Captured variables and globals the function reads, by name, as they were at entry. */
  readonly context: ReadonlyMap<string, string>
  readonly behavior: Behavior
}

export interface Behavior {
  readonly outcome: string
  readonly result: string
  readonly error: string
  /** Argument objects' texts after the call, for those the call changed ('' otherwise). */
  readonly argsAfter: readonly string[]
  readonly effects: string
  readonly output: string
}

/** The aspects in which two matched calls can differ. */
export type DiffAspect =
  'arguments' | 'context' | 'outcome' | 'result' | 'error' | 'effects' | 'output' | 'calls'

const FUNCTION_ID = /<fn#\d+ /g
/** Output of a call longer than this is compared by a hash. */
const OUTPUT_TEXT_LIMIT = 2048

/** The signature of `call` in `tree`'s recording. */
export function signatureOf(tree: CallTree, call: CallNode): CallSignature {
  const { recording } = tree
  const after = call.outcome === 'returned' ? timeAfter(call) : recording.length
  if (call.depth === 0) {
    const outcome = recording.outcome
    return {
      args: [],
      context: new Map(),
      behavior: {
        outcome: outcome.kind,
        result: '',
        error: outcome.kind === 'error' ? `${outcome.error.code} ${outcome.error.message}` : '',
        argsAfter: [],
        effects: '',
        output: outputText(recording.outputs, 0, recording.length + 1),
      },
    }
  }
  const details = tree.details(call)
  const args = details.args.map((arg) => portable(recording, call.entry, arg.value))
  // What the call did to an argument object: its text after the call when the call changed it.
  const argsAfter = details.args.map((arg, i) => {
    if (arg.value.kind !== 'ref') return ''
    const later = portable(recording, after, arg.value)
    return later === args[i] ? '' : later
  })
  return {
    args,
    context: contextOf(recording, call),
    behavior: {
      outcome: call.outcome,
      result: details.result === null ? '' : portable(recording, after, details.result.value),
      error: details.error === null ? '' : `${details.error.code} ${details.error.message}`,
      argsAfter,
      effects: details.effects.map((effect) => effect.text).join('\n'),
      output: outputText(recording.outputs, call.entry, after),
    },
  }
}

/** True when the calls were given different inputs (only names both functions read count). */
export function inputsDiffer(a: CallSignature, b: CallSignature): boolean {
  return argumentsDiffer(a, b) || contextDiffers(a, b)
}

function argumentsDiffer(a: CallSignature, b: CallSignature): boolean {
  return a.args.length !== b.args.length || a.args.some((text, i) => text !== b.args[i])
}

function contextDiffers(a: CallSignature, b: CallSignature): boolean {
  for (const [name, text] of a.context) {
    const other = b.context.get(name)
    if (other !== undefined && other !== text) return true
  }
  return false
}

/** Every aspect in which two calls differ, in a fixed order. */
export function differences(a: CallSignature, b: CallSignature): DiffAspect[] {
  const found: DiffAspect[] = []
  if (argumentsDiffer(a, b)) found.push('arguments')
  if (contextDiffers(a, b)) found.push('context')
  const x = a.behavior
  const y = b.behavior
  if (x.outcome !== y.outcome) found.push('outcome')
  if (x.result !== y.result) found.push('result')
  if (x.error !== y.error) found.push('error')
  const argsAfter =
    x.argsAfter.length !== y.argsAfter.length || x.argsAfter.some((t, i) => t !== y.argsAfter[i])
  if (x.effects !== y.effects || argsAfter) found.push('effects')
  if (x.output !== y.output) found.push('output')
  return found
}

/** True for aspects of behavior (not of input). */
export function isBehavior(aspect: DiffAspect): boolean {
  return aspect !== 'arguments' && aspect !== 'context' && aspect !== 'calls'
}

/** A value's full text with function ids removed; the shown text when it cannot be keyed. */
function portable(recording: Recording, t: number, value: ValueView): string {
  const text =
    keyText(recording, t, value) ??
    deepText(recording, t, value, 'display', KEY_TEXT_LIMIT)?.text ??
    valueText(value)
  return text.replace(FUNCTION_ID, '<fn ')
}

function contextOf(recording: Recording, call: CallNode): Map<string, string> {
  const state = recording.stateAt(call.entry)
  const context = new Map<string, string>()
  for (const capture of state.frames.at(-1)?.captures ?? []) {
    context.set(`captured ${capture.name}`, portable(recording, call.entry, capture.value))
  }
  const { program } = recording
  const proto = program.protos[call.protoId - program.firstProtoId]
  for (const name of proto === undefined ? [] : globalsReadBy(proto)) {
    const global = state.globals.find((candidate) => candidate.name === name)
    const text =
      global === undefined ? '(undefined)' : portable(recording, call.entry, global.value)
    context.set(`global ${name}`, text)
  }
  return context
}

/** The output printed by steps `from <= time < to`: the lines, or a hash of long output. */
function outputText(outputs: readonly OutputEvent[], from: number, to: number): string {
  let lo = 0
  let hi = outputs.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (outputs[mid]!.time < from) lo = mid + 1
    else hi = mid
  }
  let text = ''
  let hash = 0x811c9dc5
  let hash2 = 0x01000193
  let count = 0
  for (let i = lo; i < outputs.length && outputs[i]!.time < to; i++) {
    const line = outputs[i]!.text
    count += 1
    if (text.length <= OUTPUT_TEXT_LIMIT) text += `${line}\n`
    for (let k = 0; k <= line.length; k++) {
      const unit = k < line.length ? line.charCodeAt(k) : 10
      hash = Math.imul(hash ^ unit, 0x01000193) >>> 0
      hash2 = Math.imul(hash2 ^ unit, 0x5bd1e995) >>> 0
    }
  }
  if (text.length <= OUTPUT_TEXT_LIMIT) return text
  return `${count} lines #${hash.toString(16)}${hash2.toString(16)}`
}
