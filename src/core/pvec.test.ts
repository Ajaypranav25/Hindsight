import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { type PNode, PVec } from './pvec'

const identity = <T>(value: T): T => value

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function freshValues(vec: PVec<unknown>, serial: number): number {
  let count = 0
  vec.freshLeaves(serial, (leaf: PNode) => {
    count += leaf.slots.length
  })
  return count
}

describe('persistent vectors', () => {
  test('from builds a vector that reads back every value, at sizes around node boundaries', () => {
    for (const n of [0, 1, 31, 32, 33, 1023, 1024, 1025, 40_000]) {
      const vec = PVec.from(range(n), 1, (x) => x * 2)
      expect(vec.length).toBe(n)
      expect(vec.toArray(identity)).toEqual(range(n).map((x) => x * 2))
      expect(vec.get(n)).toBeUndefined()
      expect(vec.get(-1)).toBeUndefined()
      if (n > 0) expect(vec.get(n - 1)).toBe((n - 1) * 2)
    }
  })

  test('an edit leaves the original untouched and copies only the changed path', () => {
    const original = PVec.from(range(5000), 1, identity)
    const editor = original.edit(2)
    editor.set(17, -1)
    editor.set(4999, -2)
    const changed = editor.build()
    expect(original.get(17)).toBe(17)
    expect(original.get(4999)).toBe(4999)
    expect(changed.get(17)).toBe(-1)
    expect(changed.get(4999)).toBe(-2)
    // Two leaves were copied: a full one and the last one (5000 % 32 = 8 values).
    expect(editor.copied).toBe(32 + 8)
    expect(freshValues(changed, 1)).toBe(editor.copied)
    expect(freshValues(changed, 2)).toBe(0)
  })

  test('nodes born in the same edit are changed in place', () => {
    const editor = PVec.from(range(100), 1, identity).edit(2)
    for (let i = 0; i < 32; i++) editor.set(i, -i - 1)
    expect(editor.copied).toBe(32)
    expect(editor.build().toArray(identity).slice(0, 3)).toEqual([-1, -2, -3])
  })

  test('set grows the vector, leaving holes, and push appends', () => {
    const editor = PVec.empty<string>().edit(1)
    editor.set(3, 'd')
    editor.push('e')
    editor.set(70_000, 'z')
    const vec = editor.build()
    expect(vec.length).toBe(70_001)
    expect(vec.get(0)).toBeUndefined()
    expect(vec.get(3)).toBe('d')
    expect(vec.get(4)).toBe('e')
    expect(vec.get(70_000)).toBe('z')
    expect(vec.get(40_000)).toBeUndefined()
    const values = vec.toArray((value) => value ?? '.')
    expect(values.slice(0, 6)).toEqual(['.', '.', '.', 'd', 'e', '.'])
    expect(values[70_000]).toBe('z')
  })

  test('truncate drops the tail, shrinks the tree and keeps the original', () => {
    const original = PVec.from(range(2000), 1, identity)
    const editor = original.edit(2)
    editor.truncate(40)
    editor.push(99)
    const shorter = editor.build()
    expect(shorter.length).toBe(41)
    expect(shorter.toArray(identity)).toEqual([...range(40), 99])
    expect(shorter.shift).toBe(5)
    expect(original.toArray(identity)).toEqual(range(2000))
    const emptied = original.edit(3)
    emptied.truncate(0)
    expect(emptied.build().length).toBe(0)
    expect(PVec.empty().edit(1).build()).toBe(PVec.empty())
  })

  test('random edits agree with plain arrays, and every version stays intact', () => {
    const operation = fc.oneof(
      fc.record({ kind: fc.constant('set' as const), at: fc.nat(3000), value: fc.integer() }),
      fc.record({ kind: fc.constant('push' as const), value: fc.integer() }),
      fc.record({ kind: fc.constant('truncate' as const), at: fc.nat(3000) }),
    )
    fc.assert(
      fc.property(
        fc.nat(2000),
        fc.array(fc.array(operation, { maxLength: 20 }), { maxLength: 6 }),
        (initial, batches) => {
          let model = range(initial)
          let vec = PVec.from(model, 1, identity)
          const versions: [PVec<number>, number[]][] = [[vec, model]]
          batches.forEach((batch, index) => {
            const editor = vec.edit(index + 2)
            model = model.slice()
            for (const op of batch) {
              if (op.kind === 'push') {
                editor.push(op.value)
                model.push(op.value)
              } else if (op.kind === 'truncate') {
                editor.truncate(op.at)
                if (op.at < model.length) model.length = op.at
              } else if (op.at <= model.length) {
                editor.set(op.at, op.value)
                model[op.at] = op.value
              }
            }
            vec = editor.build()
            versions.push([vec, model])
          })
          for (const [version, expected] of versions) {
            expect(version.length).toBe(expected.length)
            expect(version.toArray(identity)).toEqual(expected)
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
