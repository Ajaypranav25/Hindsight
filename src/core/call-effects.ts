/**
 * What a call changed outside itself (ARCHITECTURE §7.6): Hindsight functions are closures that
 * can assign globals and captured variables and change lists and records in place, so "did it
 * return the right value?" is only half of the question the bug finder has to ask. The effects are
 * read from the event log between the call's first and last step: a write counts when its target
 * existed before the call began. Objects the call was given as arguments are left out; the call's
 * details already show what became of those.
 */
import type {
  ObjectView,
  ProvenanceEvent,
  Recording,
  StateView,
  TracedValue,
  ValueView,
} from './api-types'
import type { CallNode } from './calls'
import { eventsBetween } from './events'
import { preview } from './values'

export interface CallEffect {
  /** `global`/`captured`: a variable was assigned; `field`/`list`: an object was changed in place. */
  readonly kind: 'global' | 'captured' | 'field' | 'list'
  /** One clause: `global total became 118`, `order.paid became true`, `log changed (3 changes)`. */
  readonly text: string
}

export interface CallEffects {
  readonly effects: readonly CallEffect[]
  /** True when the call ran too many events to read them all: the list may be incomplete. */
  readonly truncated: boolean
}

/** The most events of one call that are read. */
export const EFFECT_EVENT_LIMIT = 20_000
const VALUE_TEXT_LIMIT = 40
const NO_EFFECTS: CallEffects = { effects: [], truncated: false }

/** The non-local state `call` changed, in the order it was first touched. */
export function callEffects(recording: Recording, call: CallNode): CallEffects {
  if (call.depth === 0) return NO_EFFECTS
  const after = call.outcome === 'returned' ? call.exit + 1 : recording.length
  const window = eventsBetween(recording, call.entry, after, EFFECT_EVENT_LIMIT)
  if (window.total === 0) return NO_EFFECTS
  const entry = recording.stateAt(call.entry)
  const names = new Names(recording, call, entry)
  const found = new Map<string, CallEffect>()
  const listChanges = new Map<number, number>()
  const final = recording.stateAt(after)
  for (const event of window.events) {
    const effect = effectOf(event, names, listChanges, final)
    if (effect !== null) {
      // A later write to the same place replaces the earlier clause but keeps its position.
      found.set(effect.key, { kind: effect.kind, text: effect.text })
    }
  }
  for (const [id, count] of listChanges) {
    const name = names.object(id) ?? 'a list'
    found.set(`list ${id}`, {
      kind: 'list',
      text: `${name} changed (${count} ${count === 1 ? 'change' : 'changes'})`,
    })
  }
  return { effects: [...found.values()], truncated: window.truncated }
}

interface Keyed extends CallEffect {
  readonly key: string
}

function effectOf(
  event: ProvenanceEvent,
  names: Names,
  listChanges: Map<number, number>,
  final: StateView,
): Keyed | null {
  const { target } = event
  const value = tracedText(event.value, final)
  switch (target.kind) {
    case 'global':
      if (event.kind !== 'write') return null
      return {
        kind: 'global',
        key: `global ${target.name}`,
        text: `global ${target.name} became ${value}`,
      }
    case 'local': {
      // A write to an open cell is reported on its owner's slot: an older frame's variable.
      if (event.kind !== 'write' || target.frameUid >= names.frameUid) return null
      const name = names.outerLocal(target.frameUid, target.slot)
      return {
        kind: 'captured',
        key: `local ${target.frameUid}:${target.slot}`,
        text: `captured ${name} became ${value}`,
      }
    }
    case 'cell': {
      if (event.kind !== 'write' || !names.existedBefore(target.cellId)) return null
      return {
        kind: 'captured',
        key: `cell ${target.cellId}`,
        text: `captured ${names.cell(target.cellId)} became ${value}`,
      }
    }
    case 'field': {
      if (!names.outside(target.objectId)) return null
      const owner = names.object(target.objectId) ?? 'a record'
      const place = `${owner}.${target.key}`
      const text = event.kind === 'delete' ? `${place} was deleted` : `${place} became ${value}`
      return { kind: 'field', key: `field ${target.objectId} ${target.key}`, text }
    }
    case 'element':
    case 'object':
      if (event.kind === 'alloc' || !names.outside(target.objectId)) return null
      listChanges.set(target.objectId, (listChanges.get(target.objectId) ?? 0) + 1)
      return null
  }
}

function tracedText(value: TracedValue, state: StateView): string {
  if (value === null) return 'nil'
  if (typeof value === 'string') return preview(value, VALUE_TEXT_LIMIT)
  if (typeof value !== 'object') return String(value)
  const object = state.heap.get(value.ref)
  if (object === undefined) return 'an object'
  return object.type === 'function' || object.type === 'builtin' ? 'a function' : `a ${object.type}`
}

/** Names for the things a call can reach when it begins, and what belongs to its arguments. */
class Names {
  readonly frameUid: number
  private readonly argumentObjects = new Set<number>()
  private readonly objectNames = new Map<number, string>()
  private readonly cellNames = new Map<number, string>()

  constructor(
    private readonly recording: Recording,
    private readonly call: CallNode,
    private readonly entry: StateView,
  ) {
    const frame = entry.frames.at(-1)
    this.frameUid = frame?.uid ?? Number.MAX_SAFE_INTEGER
    for (const local of frame?.locals ?? []) {
      if (local.kind === 'param') this.reach(local.value, null)
    }
    for (const capture of frame?.captures ?? []) {
      if (capture.target.kind === 'cell') this.cellNames.set(capture.target.cellId, capture.name)
      this.reach(capture.value, capture.name)
    }
    for (const global of entry.globals) this.reach(global.value, global.name)
  }

  /** True for an object that existed before the call and is not (part of) an argument. */
  outside(objectId: number): boolean {
    return this.existedBefore(objectId) && !this.argumentObjects.has(objectId)
  }

  existedBefore(objectId: number): boolean {
    const allocated = this.recording.allocationTime(objectId)
    return allocated === null || allocated < this.call.entry
  }

  object(objectId: number): string | null {
    return this.objectNames.get(objectId) ?? null
  }

  cell(cellId: number): string {
    return this.cellNames.get(cellId) ?? 'variable'
  }

  outerLocal(frameUid: number, slot: number): string {
    const frame = this.entry.frames.find((candidate) => candidate.uid === frameUid)
    return frame?.locals.find((local) => local.slot === slot)?.name ?? 'variable'
  }

  /**
   * Walks what `value` reaches in the entry state (breadth first, each object once). With a
   * `name`, the objects get path names (`config.rates`); without, they are argument objects.
   */
  private reach(value: ValueView, name: string | null): void {
    if (value.kind !== 'ref') return
    const work: { readonly id: number; readonly path: string | null; readonly depth: number }[] = [
      { id: value.id, path: name, depth: 0 },
    ]
    const seen = new Set<number>()
    for (let i = 0; i < work.length; i++) {
      const { id, path, depth } = work[i]!
      if (seen.has(id)) continue
      seen.add(id)
      if (path === null) this.argumentObjects.add(id)
      else if (!this.objectNames.has(id)) this.objectNames.set(id, path)
      const object = this.entry.heap.get(id)
      if (object === undefined || depth >= 3) continue
      for (const [child, step] of childrenOf(object)) {
        if (child.kind !== 'ref') continue
        work.push({ id: child.id, path: path === null ? null : `${path}${step}`, depth: depth + 1 })
      }
    }
  }
}

function childrenOf(object: ObjectView): (readonly [ValueView, string])[] {
  switch (object.type) {
    case 'list':
      return object.items.map((item, i) => [item, `[${object.offset + i}]`] as const)
    case 'record':
      return object.entries.map((entry) => [entry.value, `.${entry.key}`] as const)
    default:
      return []
  }
}
