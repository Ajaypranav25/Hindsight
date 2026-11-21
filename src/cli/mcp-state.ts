/**
 * Program states as JSON for `seek_state` (ARCHITECTURE §9.1), within budgets an agent chooses:
 * how deep lists and records are expanded, how many items each shows, which frames are listed
 * and whether globals are included. Expansion pages through `Recording.objectAt` with an explicit
 * work stack, never recursion.
 */
import { LineIndex, type Recording, type StateView, type ValueView } from '../core/index'
import { type Json, valueJson } from './mcp-shared'

export interface ValueLimits {
  /** Levels of lists and records expanded (0: previews only). */
  readonly depth: number
  /** Items or entries shown per list or record. */
  readonly items: number
}

export const DEFAULT_VALUE_LIMITS: ValueLimits = { depth: 1, items: 20 }
export const MAX_VALUE_DEPTH = 8
export const MAX_VALUE_ITEMS = 200

interface Task {
  readonly value: ValueView
  readonly depth: number
  readonly assign: (json: Json) => void
}

/** `value` at `time`, lists and records expanded `limits.depth` levels deep. */
export function deepValueJson(
  recording: Recording,
  time: number,
  value: ValueView,
  limits: ValueLimits,
): { readonly json: Json; readonly cut: boolean } {
  let result: Json = null
  let cut = false
  const work: Task[] = [{ value, depth: 0, assign: (json) => (result = json) }]
  while (work.length > 0) {
    const task = work.pop()!
    const shown = task.value
    if (shown.kind !== 'ref' || task.depth >= limits.depth) {
      task.assign(valueJson(shown))
      continue
    }
    if (shown.type !== 'list' && shown.type !== 'record') {
      task.assign(valueJson(shown))
      continue
    }
    const object = recording.objectAt(time, shown.id, { offset: 0, limit: limits.items })
    if (object === null || (object.type !== 'list' && object.type !== 'record')) {
      task.assign(valueJson(shown))
      continue
    }
    const base: Record<string, Json> = {
      object: shown.id,
      type: object.type,
      preview: shown.preview,
      length: object.length,
    }
    const more =
      object.length - (object.type === 'list' ? object.items.length : object.entries.length)
    if (more > 0) {
      base.more = more
      cut = true
    }
    if (object.type === 'list') {
      const items: Json[] = object.items.map(() => null)
      base.items = items
      object.items.forEach((item, i) =>
        work.push({ value: item, depth: task.depth + 1, assign: (json) => (items[i] = json) }),
      )
    } else {
      // Keys like "__proto__" must stay ordinary properties: define them, never assign.
      const entries: Record<string, Json> = Object.fromEntries(
        object.entries.map((entry) => [entry.key, null]),
      )
      base.entries = entries
      for (const entry of object.entries) {
        work.push({
          value: entry.value,
          depth: task.depth + 1,
          assign: (json) =>
            Object.defineProperty(entries, entry.key, {
              value: json,
              enumerable: true,
              writable: true,
              configurable: true,
            }),
        })
      }
    }
    task.assign(base)
  }
  return { json: result, cut }
}

export type FrameChoice = 'all' | 'top' | number

export interface StateOptions {
  readonly limits: ValueLimits
  readonly frames: FrameChoice
  readonly globals: boolean
}

export function stateJson(recording: Recording, state: StateView, options: StateOptions): Json {
  const { location } = state
  const index = new LineIndex(recording.program.source)
  const printed = recording.outputs.slice(0, state.outputCount)
  const notes: string[] = []
  let cut = false
  const render = (value: ValueView): Json => {
    const rendered = deepValueJson(recording, state.time, value, options.limits)
    cut ||= rendered.cut
    return rendered.json
  }
  const innermostFirst = [...state.frames].reverse()
  const wanted =
    options.frames === 'all' ? innermostFirst.length : options.frames === 'top' ? 1 : options.frames
  const frames = innermostFirst.slice(0, wanted)
  if (frames.length < innermostFirst.length) {
    notes.push(
      `showing ${frames.length} of ${innermostFirst.length} frames (innermost first); pass frames: "all" or a larger number for more`,
    )
  }
  const result: Record<string, Json> = {
    step: state.time,
    steps: recording.length,
    location:
      location === null
        ? null
        : {
            line: location.source === 'main' ? location.line : null,
            function: location.functionName,
            library: location.library,
            instruction: location.opName,
            depth: location.depth,
          },
    frames: frames.map((frame) => ({
      function: frame.name,
      line: frame.library ? null : index.lineOf(frame.span.start),
      locals: Object.fromEntries(frame.locals.map((local) => [local.name, render(local.value)])),
      captured: Object.fromEntries(
        frame.captures.map((capture) => [capture.name, render(capture.value)]),
      ),
    })),
    frames_total: innermostFirst.length,
  }
  if (options.globals) {
    result.globals = Object.fromEntries(
      state.globals.map((global) => [global.name, render(global.value)]),
    )
  }
  result.output_lines_so_far = printed.length
  result.last_output = printed.slice(-10).map((output) => output.text)
  result.error =
    state.error === null ? null : { code: state.error.code, message: state.error.message }
  if (cut) {
    notes.push(
      `lists and records show at most ${options.limits.items} items ("more" counts the rest); raise max_items, or pass max_depth to expand deeper`,
    )
  }
  if (notes.length > 0) result.notes = notes
  return result
}
