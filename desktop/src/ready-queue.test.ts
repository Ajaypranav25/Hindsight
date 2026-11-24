import { describe, expect, test } from 'vitest'
import { MAX_QUEUED, ReadyQueue } from './ready-queue'

describe('ReadyQueue', () => {
  test('holds requests until the page is ready, then hands them over in order', () => {
    // Arrange
    const queue = new ReadyQueue<string>()

    // Act
    const early = [queue.push('a'), queue.push('b')]
    const released = queue.markReady()

    // Assert
    expect(early).toEqual([[], []])
    expect(released).toEqual(['a', 'b'])
    expect(queue.isReady).toBe(true)
  })

  test('delivers at once while the page is ready', () => {
    const queue = new ReadyQueue<string>()
    queue.markReady()

    expect(queue.push('c')).toEqual(['c'])
    expect(queue.markReady()).toEqual([])
  })

  test('waits again after the page reloads', () => {
    // Arrange
    const queue = new ReadyQueue<string>()
    queue.markReady()

    // Act
    queue.reset()
    const pushed = queue.push('d')

    // Assert
    expect(queue.isReady).toBe(false)
    expect(pushed).toEqual([])
    expect(queue.markReady()).toEqual(['d'])
  })

  test('keeps only the latest requests', () => {
    const queue = new ReadyQueue<number>(3)
    for (const value of [1, 2, 3, 4, 5]) queue.push(value)

    expect(queue.markReady()).toEqual([3, 4, 5])
    expect(MAX_QUEUED).toBeGreaterThan(1)
  })
})
