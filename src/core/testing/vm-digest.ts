/**
 * A complete, id-preserving text digest of a VM's state for tests that compare machines
 * (snapshot/restore, hooks on versus off). Built from a snapshot so it sees every field of the
 * machine record, including the object counter and the generator.
 */
import type { HeapObject, Value, VM } from '../runtime-types'
import { MachineSnapshot } from '../vm-snapshot'

export function digest(vm: VM): string {
  const snapshot = vm.snapshot()
  if (!(snapshot instanceof MachineSnapshot)) throw new Error('not a machine snapshot')
  const record = snapshot.record
  const seen = new Set<HeapObject>()
  const objects: string[] = []
  const describe = (value: Value): string => describeValue(value, seen, objects)
  const parts = [
    `time=${record.time} status=${record.status} next=${record.nextObjectId}/${record.nextFrameUid}`,
    `rng=${record.rngState}`,
    `stack=${record.stack.map(describe).join(',')}`,
    `frames=${record.frames.map((f) => `${f.uid}:${f.closure.proto.id}@${f.ip}+${f.base}`).join(',')}`,
    `cells=${record.openCells.map((c) => `${c.id}@${c.stackIndex}`).join(',')}`,
    `globals=${Array.from(record.globals, ([k, v]) => `${k}=${describe(v)}`).join(',')}`,
  ]
  return [...parts, ...objects].join('\n')
}

/** Primitives inline; heap objects by id, with their contents appended once to `objects`. */
function describeValue(root: Value, seen: Set<HeapObject>, objects: string[]): string {
  const work: Value[] = [root]
  while (work.length > 0) {
    const value = work.pop() as Value
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)
    objects.push(`#${value.id} ${contents(value, work)}`)
  }
  return atom(root)
}

function atom(value: Value): string {
  if (typeof value === 'object' && value !== null) return `#${value.id}`
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function contents(object: HeapObject, work: Value[]): string {
  switch (object.type) {
    case 'list':
      work.push(...object.items)
      return `list[${object.items.map(atom).join(',')}]`
    case 'record':
      work.push(...object.fields.values())
      return `record{${Array.from(object.fields, ([k, v]) => `${k}:${atom(v)}`).join(',')}}`
    case 'closure':
      work.push(...object.upvalues)
      return `closure ${object.proto.id} [${object.upvalues.map(atom).join(',')}]`
    case 'cell':
      work.push(object.value)
      return `cell ${object.open ? 'open' : 'closed'} ${object.stackIndex} ${atom(object.value)} ${object.ownerFrameUid}/${object.slot}`
    case 'iterator':
      work.push(object.source)
      return `iter ${atom(object.source)} ${object.position} ${object.keys?.join('|') ?? ''}`
    case 'range':
      return `range ${object.start} ${object.end} ${object.step} ${object.inclusive}`
    case 'native':
      return `native ${object.name}`
  }
}
