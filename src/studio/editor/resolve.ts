/** Pure name resolution for the hover tooltip. */
import type { FrameView, StateView, ValueView, WriteTarget } from '../../core/index'

export interface ResolvedName {
  readonly name: string
  /** A local kind (let, var, param, fn, loop, match), "captured", or a global kind. */
  readonly kind: string
  readonly value: ValueView
  readonly target: WriteTarget
}

/** Resolves `name` in the frame's locals (innermost binding wins), then captures, then globals. */
export function resolveName(
  name: string,
  view: StateView,
  frame: FrameView | null,
): ResolvedName | null {
  if (frame) {
    const locals = frame.locals.filter((local) => local.name === name && local.kind !== 'hidden')
    const local = locals[locals.length - 1]
    if (local) return { name, kind: local.kind, value: local.value, target: local.target }
    const capture = frame.captures.find((c) => c.name === name)
    if (capture) return { name, kind: 'captured', value: capture.value, target: capture.target }
  }
  const global = view.globals.find((g) => g.name === name)
  if (global) return { name, kind: global.kind, value: global.value, target: global.target }
  return null
}
