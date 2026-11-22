import { expect, test } from 'vitest'
import { buildMarkPyramid, markedColumns } from './mark-pyramid'

test('the slice marks of a million-step run draw in milliseconds', () => {
  // Arrange
  const marks = new Uint8Array(1_000_001)
  for (let i = 0; i < marks.length; i += 997) marks[i] = 1
  const pyramid = buildMarkPyramid(marks)
  // Act
  const started = performance.now()
  const columns = markedColumns(pyramid, { start: 0, end: marks.length }, 2400)
  const elapsed = performance.now() - started
  // Assert
  expect(elapsed).toBeLessThan(20)
  expect(columns.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(900)
})
