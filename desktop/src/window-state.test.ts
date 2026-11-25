import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SIZE,
  MIN_SIZE,
  parseWindowState,
  placeWindow,
  serializeWindowState,
  type Rect,
  type WindowState,
} from './window-state'

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const SECOND: Rect = { x: 1920, y: 0, width: 1280, height: 984 }
const SAVED: WindowState = { bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: false }

describe('the saved window state', () => {
  test('round-trips through its file', () => {
    expect(parseWindowState(serializeWindowState(SAVED))).toEqual(SAVED)
  })

  test('a broken or implausible file is ignored', () => {
    for (const text of [
      '',
      'not json',
      'null',
      '[]',
      '{"bounds":{"x":0,"y":0,"width":1200,"height":800}}',
      '{"bounds":null,"maximized":false}',
      '{"bounds":{"x":0.5,"y":0,"width":1200,"height":800},"maximized":false}',
      '{"bounds":{"x":0,"y":"0","width":1200,"height":800},"maximized":false}',
      `{"bounds":{"x":0,"y":0,"width":${MIN_SIZE.width - 1},"height":800},"maximized":false}`,
      '{"bounds":{"x":0,"y":0,"width":1200,"height":1e9},"maximized":false}',
    ])
      expect(parseWindowState(text), text).toBeNull()
  })
})

describe('placeWindow', () => {
  test('the first window gets the default size and the system places it', () => {
    expect(placeWindow(null, [PRIMARY])).toEqual({ ...DEFAULT_SIZE, maximized: false })
  })

  test('a saved window goes back where it was, maximized or not', () => {
    expect(placeWindow(SAVED, [PRIMARY, SECOND])).toEqual({ ...SAVED.bounds, maximized: false })
    expect(placeWindow({ ...SAVED, maximized: true }, [PRIMARY]).maximized).toBe(true)
  })

  test('a window on a second display stays there, shrunk to fit it', () => {
    // Arrange
    const saved: WindowState = {
      bounds: { x: 2000, y: 10, width: 1800, height: 1200 },
      maximized: false,
    }

    // Act
    const placement = placeWindow(saved, [PRIMARY, SECOND])

    // Assert
    expect(placement).toEqual({ x: 2000, y: 10, width: 1280, height: 984, maximized: false })
  })

  test('a window whose display is gone moves back to the primary display', () => {
    // Arrange: it was on the second display, which is now unplugged.
    const saved: WindowState = {
      bounds: { x: 2000, y: 10, width: 1000, height: 700 },
      maximized: true,
    }

    // Act
    const placement = placeWindow(saved, [PRIMARY])

    // Assert
    expect(placement).toEqual({ ...DEFAULT_SIZE, maximized: true })
  })

  test('a window whose title bar is off screen is not restored there', () => {
    const above: WindowState = {
      bounds: { x: 100, y: -700, width: 1000, height: 720 },
      maximized: false,
    }
    const edge: WindowState = {
      bounds: { x: 1880, y: 100, width: 1000, height: 720 },
      maximized: false,
    }

    expect(placeWindow(above, [PRIMARY]).x).toBeUndefined()
    expect(placeWindow(edge, [PRIMARY]).x).toBeUndefined()
  })

  test('the default size shrinks to a small screen, and copes with none reported', () => {
    expect(placeWindow(null, [{ x: 0, y: 0, width: 1280, height: 680 }])).toEqual({
      width: 1280,
      height: 680,
      maximized: false,
    })
    expect(placeWindow(null, [])).toEqual({ ...DEFAULT_SIZE, maximized: false })
  })
})
