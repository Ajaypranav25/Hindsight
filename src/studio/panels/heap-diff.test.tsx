// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { compile, record, type Recording } from '../../core/index'
import { collectRoots, layoutHeap, type HeapLayout } from '../lib/heap-layout'
import { diffLayouts, sameReferences } from '../lib/heap-layout-diff'
import { heapDiffText } from './HeapDiff'
import { HeapGraph } from './HeapGraph'
import { renderWithRecording } from './test-fixtures'

afterEach(cleanup)

const LIST =
  'let tail = {value: 2, next: nil}\nlet other = {value: 9, next: nil}\n' +
  'let head = {value: 1, next: tail}\nvar count = 0\ncount = count + 1\nprint(head.next.value)\n'

function recordSource(source: string): Recording {
  const result = compile(source)
  if (!result.ok) throw new Error('fixture does not compile')
  return record(result.program)
}

function layoutAt(recording: Recording, time: number): HeapLayout {
  const view = recording.stateAt(time)
  return layoutHeap(
    { roots: collectRoots(view.frames.at(-1) ?? null, view.globals), heap: view.heap },
    null,
  )
}

/** The real run, and a fork where `head.next` was cut just before the last line. */
function cut() {
  const real = recordSource(LIST)
  const at = real.lineHits(6)[0]!
  const head = real.stateAt(at).globals.find((global) => global.name === 'head')!
  if (head.value.kind !== 'ref') throw new Error('head is not an object')
  const target = { kind: 'field', objectId: head.value.id, key: 'next' } as const
  const fork = real.fork(at, { target, value: null })
  if (!fork.ok) throw new Error(fork.error.message)
  return { real, fork: fork.recording, at, headId: head.value.id }
}

describe('heap layout differences', () => {
  test('identical states have the same references', () => {
    const real = recordSource(LIST)
    const at = real.lineHits(6)[0]!
    const diff = diffLayouts(layoutAt(real, at), layoutAt(real, at))
    expect(sameReferences(diff)).toBe(true)
    expect(diff.removed).toEqual([])
  })

  test('a cut link is a ghost from its row to its old target', () => {
    const { real, fork, at, headId } = cut()
    const diff = diffLayouts(layoutAt(fork, at + 1), layoutAt(real, at + 1))
    expect(diff.added.size).toBe(0)
    expect(diff.removed).toHaveLength(1)
    expect(diff.removed[0]).toMatchObject({ reaches: true })
    expect(diff.removed[0]!.path).toMatch(/^M[\d.]+,[\d.]+ C/)
    expect(diff.removedTexts).toEqual([
      expect.stringMatching(new RegExp(`^#${headId} next pointed to #\\d+$`)),
    ])
    expect(heapDiffText(diff)).toMatch(/^Only in the real run: #\d+ next pointed to #\d+\.$/)
  })

  test('seen from the other side the same link is an added reference', () => {
    const { real, fork, at } = cut()
    const diff = diffLayouts(layoutAt(real, at + 1), layoutAt(fork, at + 1))
    expect(diff.removed).toEqual([])
    expect(diff.added.size).toBe(1)
    expect(diff.addedTexts[0]).toMatch(/next now points to #\d+$/)
    expect(heapDiffText(diff)).toMatch(/^Only in the what-if: /)
  })

  test('a lost reference to an object that is no longer drawn is a stub', () => {
    const source = 'var keep = {a: 1}\nvar only = [keep]\nprint(1)\nprint(2)\n'
    const real = recordSource(source)
    const at = real.lineHits(3)[0]!
    const only = real.stateAt(at).globals.find((global) => global.name === 'only')!
    const fork = real.fork(at, { target: only.target, value: 0 })
    if (!fork.ok) throw new Error(fork.error.message)
    const diff = diffLayouts(layoutAt(fork.recording, at + 1), layoutAt(real, at + 1))
    const stub = diff.removed.find((edge) => !edge.reaches)
    expect(stub?.path).toMatch(/ h36$/)
    expect(diff.removedTexts).toContain(`only pointed to #${(only.value as { id: number }).id}`)
  })
})

describe('HeapGraph during a what-if', () => {
  test('draws the lost link dashed, with a legend and a description', () => {
    const { real, fork, at } = cut()
    const { store, container } = renderWithRecording(<HeapGraph />, real, at + 1)
    expect(screen.queryByRole('group', { name: 'Compared with the real run' })).toBeNull()
    act(() =>
      store.setState({
        recording: fork,
        whatIf: {
          parent: real,
          parentTime: at,
          edits: [{ time: at, text: 'next = nil' }],
          label: 'next = nil',
          comparison: { divergence: at, lines: [], removed: 0, added: 0 },
        },
      }),
    )
    const legend = screen.getByRole('group', { name: 'Compared with the real run' })
    expect(legend.textContent).toContain('only in the real run (1)')
    expect(legend.textContent).toContain('only in the what-if (0)')
    expect(legend.textContent).toMatch(/Only in the real run: #\d+ next pointed to #\d+\./)
    const ghosts = container.querySelectorAll('.hp-viewport .hp-edge.is-removed')
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0]!.getAttribute('marker-end')).toContain('arrow-removed')
    // Before the fork step the two runs are the same: nothing to compare.
    act(() => store.setState({ time: at - 1 }))
    expect(screen.queryByRole('group', { name: 'Compared with the real run' })).toBeNull()
  })
})
