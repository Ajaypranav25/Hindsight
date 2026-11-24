/**
 * The window's size, position and maximized state, kept in the user's data folder between runs.
 * The saved file is untrusted (hand-edited, from an older version, from a machine whose monitors
 * have since changed), so it is validated and the window is put back only where it can be seen.
 */

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowState {
  readonly bounds: Rect
  readonly maximized: boolean
}

/** Where a new window goes: a size, and a position only when restoring a visible one. */
export interface WindowPlacement {
  readonly x?: number
  readonly y?: number
  readonly width: number
  readonly height: number
  readonly maximized: boolean
}

export const DEFAULT_SIZE = { width: 1440, height: 900 } as const
/** The studio's narrow layout still works at this size. */
export const MIN_SIZE = { width: 720, height: 520 } as const
/** Larger than any display; anything bigger is a corrupt file. */
const MAX_DIMENSION = 100_000
/** How much of the window's top edge must be on a display for it to be grabbed and moved. */
const GRAB_WIDTH = 96
const GRAB_HEIGHT = 24

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_DIMENSION
}

function isLength(value: unknown, min: number): value is number {
  return isCoordinate(value) && value >= min
}

/** The saved state, or null when `text` is not a valid one. */
export function parseWindowState(text: string): WindowState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { bounds, maximized } = value as Record<string, unknown>
  if (typeof maximized !== 'boolean' || typeof bounds !== 'object' || bounds === null) return null
  const { x, y, width, height } = bounds as Record<string, unknown>
  if (!isCoordinate(x) || !isCoordinate(y)) return null
  if (!isLength(width, MIN_SIZE.width) || !isLength(height, MIN_SIZE.height)) return null
  return { bounds: { x, y, width, height }, maximized }
}

export function serializeWindowState(state: WindowState): string {
  const { x, y, width, height } = state.bounds
  return `${JSON.stringify({ bounds: { x, y, width, height }, maximized: state.maximized }, null, 2)}\n`
}

function overlap(a: Rect, b: Rect): { readonly width: number; readonly height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

/** The work area that holds enough of the window's top edge (its title bar), if any. */
function areaHolding(bounds: Rect, workAreas: readonly Rect[]): Rect | undefined {
  const topEdge = { x: bounds.x, y: bounds.y, width: bounds.width, height: GRAB_HEIGHT }
  return workAreas.find((area) => {
    const shared = overlap(topEdge, area)
    return shared.width >= GRAB_WIDTH && shared.height >= GRAB_HEIGHT
  })
}

/**
 * Where to open the window. A saved window goes back where it was when its title bar is still on
 * a display (shrunk to fit that display); otherwise, and the first time, it gets the default size
 * (shrunk to fit the primary display, `workAreas[0]`) and the system places it.
 */
export function placeWindow(
  saved: WindowState | null,
  workAreas: readonly Rect[],
): WindowPlacement {
  const primary = workAreas[0]
  const area = saved === null ? undefined : areaHolding(saved.bounds, workAreas)
  if (saved !== null && area !== undefined) {
    return {
      x: saved.bounds.x,
      y: saved.bounds.y,
      width: Math.min(saved.bounds.width, area.width),
      height: Math.min(saved.bounds.height, area.height),
      maximized: saved.maximized,
    }
  }
  return {
    width: primary === undefined ? DEFAULT_SIZE.width : Math.min(DEFAULT_SIZE.width, primary.width),
    height:
      primary === undefined ? DEFAULT_SIZE.height : Math.min(DEFAULT_SIZE.height, primary.height),
    maximized: saved?.maximized ?? false,
  }
}
