/**
 * What-if forks against the gallery (ARCHITECTURE §7.5, §10.3): a fork whose edit writes the value
 * its target already holds must reproduce the real run exactly.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  compareRecordings,
  compile,
  type EditValue,
  type ForkEdit,
  record,
  type Recording,
  type StateView,
  type ValueView,
  type WriteTarget,
} from '../src/core/index'

const dir = fileURLToPath(new URL('../examples/', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sight'))
  .sort()

/** Keeps the property fast: long examples are recorded up to a step limit, which forks inherit. */
const MAX_STEPS = 60_000

function primitive(value: ValueView): EditValue | undefined {
  switch (value.kind) {
    case 'nil':
      return null
    case 'ref':
      return undefined
    default:
      return value.value
  }
}

/** Every primitive a user could edit at the pen: variables, captures, elements and fields. */
function sameValueEdits(view: StateView): ForkEdit[] {
  const edits: ForkEdit[] = []
  const add = (target: WriteTarget, value: ValueView) => {
    const current = primitive(value)
    if (current !== undefined) edits.push({ target, value: current })
  }
  for (const global of view.globals) add(global.target, global.value)
  for (const frame of view.frames) {
    for (const local of frame.locals) add(local.target, local.value)
    for (const capture of frame.captures) add(capture.target, capture.value)
  }
  for (const object of view.heap.values()) {
    if (object.type === 'list') {
      object.items.forEach((item, i) =>
        add({ kind: 'element', objectId: object.id, index: object.offset + i }, item),
      )
    } else if (object.type === 'record') {
      for (const { key, value } of object.entries)
        add({ kind: 'field', objectId: object.id, key }, value)
    }
  }
  return edits
}

function recordExample(file: string): Recording {
  const compiled = compile(readFileSync(`${dir}${file}`, 'utf8'))
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
  return record(compiled.program, { maxSteps: MAX_STEPS })
}

describe('a fork that writes the value a target already has reproduces the run', () => {
  test.each(files)('%s', (file) => {
    const parent = recordExample(file)
    const n = parent.length
    fc.assert(
      fc.property(fc.integer({ min: 0, max: n - 1 }), fc.nat(), fc.nat(), (time, pick, sample) => {
        const edits = sameValueEdits(parent.stateAt(time))
        fc.pre(edits.length > 0)
        const edit = edits[pick % edits.length]!
        const result = parent.fork(time, edit)
        if (!result.ok) throw new Error(`${JSON.stringify(edit)}: ${result.error.message}`)
        const fork = result.recording
        expect(fork.length).toBe(n)
        expect(fork.outcome).toEqual(parent.outcome)
        expect(fork.outputs).toEqual(parent.outputs)
        for (const t of [Math.max(0, time - 1), time, Math.min(n, time + 1), sample % (n + 1), n]) {
          expect(fork.stateAt(t)).toEqual(parent.stateAt(t))
        }
        expect(compareRecordings(parent, fork).divergence).toBeNull()
      }),
      { numRuns: 6 },
    )
  })
})
