/**
 * Pattern matching (SPEC §6, ARCHITECTURE §6.5): `Destructure`, `MatchPattern` and `NoMatch`.
 *
 * Bindings are collected in binding order (SPEC §6.2) into a reusable buffer and pushed only when
 * the whole pattern matched; a rest binding allocates its new list at that point, so a failed match
 * allocates nothing. Matching recurses over the pattern (whose depth the parser bounds), never over
 * the data beyond the pattern's shape.
 */
import type { PatternConst, PatternDesc } from './bytecode'
import type { ListObj, Value } from './runtime-types'
import { equals, isList, isRecord, preview } from './values'
import { raise } from './vm-errors'
import { type Binding, type MachineState, RestSlice } from './vm-state'

/** Reprs in R014/R015 are cut to 60 code units (SPEC §11). */
const MESSAGE_REPR_LENGTH = 60

/** `Destructure`: `( v -- b1…bm )`, R014 on mismatch. */
export function destructure(m: MachineState, pattern: PatternConst): void {
  const stack = m.stack
  const value = stack[stack.length - 1] as Value
  if (!collect(m, pattern.desc, value)) {
    const shown = preview(value, MESSAGE_REPR_LENGTH)
    raise('R014', `value ${shown} does not match pattern ${pattern.text}`)
  }
  stack.pop()
  pushBindings(m)
}

/** `MatchPattern`: pushes the bindings and returns true on success; leaves the stack otherwise. */
export function matchPattern(m: MachineState, pattern: PatternConst): boolean {
  const stack = m.stack
  if (!collect(m, pattern.desc, stack[stack.length - 1] as Value)) return false
  pushBindings(m)
  return true
}

/** `NoMatch`: R015 with the subject on top of the stack. */
export function noMatch(m: MachineState): never {
  const subject = m.stack[m.stack.length - 1] as Value
  return raise('R015', `no match arm matched the value ${preview(subject, MESSAGE_REPR_LENGTH)}`)
}

function collect(m: MachineState, desc: PatternDesc, value: Value): boolean {
  const bindings = m.bindings
  bindings.length = 0
  if (matches(desc, value, bindings)) return true
  bindings.length = 0
  return false
}

function pushBindings(m: MachineState): void {
  const bindings = m.bindings
  const stack = m.stack
  for (const binding of bindings) {
    stack.push(
      binding instanceof RestSlice
        ? m.newList(binding.list.items.slice(binding.start, binding.end))
        : binding,
    )
  }
  bindings.length = 0
}

function matches(desc: PatternDesc, value: Value, out: Binding[]): boolean {
  switch (desc.t) {
    case 'any':
      return true
    case 'bind':
      out.push(value)
      return true
    case 'lit':
      return equals(value, desc.value)
    case 'range':
      return (
        typeof value === 'number' &&
        value >= desc.start &&
        (desc.inclusive ? value <= desc.end : value < desc.end)
      )
    case 'list':
      return isList(value) && matchesList(desc, value, out)
    case 'record':
      return isRecord(value) && matchesRecord(desc.fields, value.fields, out)
    case 'or':
      return matchesAlternative(desc.alternatives, value, out)
  }
}

type ListDesc = Extract<PatternDesc, { t: 'list' }>
type RecordFields = Extract<PatternDesc, { t: 'record' }>['fields']

function matchesList(desc: ListDesc, list: ListObj, out: Binding[]): boolean {
  const items = list.items
  const fixed = desc.before.length + desc.after.length
  if (desc.rest === 'none' ? items.length !== fixed : items.length < fixed) return false
  for (let i = 0; i < desc.before.length; i++) {
    if (!matches(desc.before[i]!, items[i]!, out)) return false
  }
  const afterStart = items.length - desc.after.length
  if (desc.rest === 'bind') out.push(new RestSlice(list, desc.before.length, afterStart))
  for (let j = 0; j < desc.after.length; j++) {
    if (!matches(desc.after[j]!, items[afterStart + j]!, out)) return false
  }
  return true
}

function matchesRecord(
  fields: RecordFields,
  values: ReadonlyMap<string, Value>,
  out: Binding[],
): boolean {
  for (const field of fields) {
    const value = values.get(field.key)
    if (value === undefined || !matches(field.pattern, value, out)) return false
  }
  return true
}

function matchesAlternative(
  alternatives: readonly PatternDesc[],
  value: Value,
  out: Binding[],
): boolean {
  const mark = out.length
  for (const alternative of alternatives) {
    if (matches(alternative, value, out)) return true
    out.length = mark
  }
  return false
}
