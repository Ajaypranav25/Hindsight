import { describe, expect, test } from 'vitest'
import { anyMarked, buildMarkPyramid, markedColumns } from './mark-pyramid'

function marksAt(length: number, steps: readonly number[]): Uint8Array {
  const marks = new Uint8Array(length)
  for (const step of steps) marks[step] = 1
  return marks
}

describe('mark pyramids', () => {
  test('count the marks and answer ranges like a scan would', () => {
    // Arrange
    const marks = marksAt(37, [0, 5, 6, 20, 36])
    // Act
    const pyramid = buildMarkPyramid(marks)
    // Assert
    expect(pyramid.count).toBe(5)
    for (let from = 0; from <= 37; from++) {
      for (let to = from; to <= 38; to++) {
        const scanned = [...marks.slice(from, to)].some((mark) => mark !== 0)
        expect(anyMarked(pyramid, from, to)).toBe(scanned)
      }
    }
  })

  test('an empty array has no marks anywhere', () => {
    const pyramid = buildMarkPyramid(new Uint8Array(0))
    expect(pyramid.levels).toHaveLength(0)
    expect(anyMarked(pyramid, 0, 10)).toBe(false)
    expect([...markedColumns(pyramid, { start: 0, end: 10 }, 4)]).toEqual([0, 0, 0, 0])
  })

  test('columns cover the steps of their part of the view', () => {
    const pyramid = buildMarkPyramid(marksAt(100, [3, 50, 99]))
    expect([...markedColumns(pyramid, { start: 0, end: 100 }, 10)]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 1,
    ])
    // Zoomed in: one step spans several columns, each of which shows it.
    expect([...markedColumns(pyramid, { start: 49, end: 52 }, 6)]).toEqual([0, 0, 1, 1, 0, 0])
    expect(markedColumns(pyramid, { start: 5, end: 5 }, 3)).toEqual(new Uint8Array(3))
  })
})
