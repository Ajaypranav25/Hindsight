/**
 * The step profiler (ARCHITECTURE §7.15): where a recorded run spent its steps. A step is one
 * instruction (SPEC §10.1), so the profile is exact and deterministic: per function the steps
 * spent inside its calls (inclusive) and in its own code (exclusive), the number of calls and the
 * average and largest call; per source line the steps of the statements that start on it; and the
 * stack paths with their exclusive steps, as folded stacks (Brendan Gregg's format) for flame
 * graphs. Built from the call tree (`calls.ts`) and one pass over the trace; deep recursion is
 * walked with explicit stacks.
 *
 * With just-my-code, library calls are transparent: their steps count as the exclusive steps of
 * the user call that made them (and of the line it was waiting on), and the user functions they
 * call (the callback given to `map`) become children of that user call.
 */
import type { Recording } from './api-types'
import { type CallNode, type CallTree, callTree, type LineSpan } from './calls'
import { LineIndex } from './span'

export interface ProfileOptions {
  /** Fold library calls into the user calls that made them. Default false. */
  readonly justMyCode?: boolean
  /** Compute per-line steps (one pass over the trace). Default true. */
  readonly lines?: boolean
}

export interface FunctionProfile {
  /** A function name, `lambda`, or `<top level>`. */
  readonly name: string
  /** `name`, with lambdas told apart by their line: `lambda@12`. */
  readonly label: string
  readonly protoId: number
  readonly library: boolean
  /** The function's lines in the main source; null for library code. */
  readonly lines: LineSpan | null
  readonly calls: number
  /**
   * Steps while the function was running, its callees included; a recursive call inside another
   * call of the same function is not counted twice.
   */
  readonly inclusive: number
  /** Steps of the function's own code (with just-my-code, also the library code it called). */
  readonly exclusive: number
  /** The mean of the calls' own inclusive steps (each call counted whole). */
  readonly average: number
  /** The largest call's inclusive steps. */
  readonly max: number
  /** The entry step of its first call. */
  readonly firstEntry: number
}

export interface LineProfile {
  /** 1-based line in the main source. */
  readonly line: number
  /** Steps of statements that start on the line (with just-my-code, library steps they caused). */
  readonly steps: number
}

/** A stack path: every call reached through the same chain of functions, aggregated. */
export interface ProfileNode {
  readonly label: string
  readonly name: string
  readonly protoId: number
  readonly library: boolean
  readonly calls: number
  readonly inclusive: number
  /** Steps of this path's own code. */
  readonly self: number
  /** The entry step of the first call on this path. */
  readonly firstEntry: number
  /** In order of their first call. */
  readonly children: readonly ProfileNode[]
}

export interface FoldedStack {
  /** Labels from the top level down: `<top level>;main;fib`. */
  readonly stack: string
  /** Exclusive steps of the calls on that path. */
  readonly steps: number
}

export interface Profile {
  /** Steps in the run (N). */
  readonly steps: number
  readonly justMyCode: boolean
  /** By inclusive steps, then exclusive, then label. */
  readonly functions: readonly FunctionProfile[]
  /** By steps, then line; empty when `lines: false`. */
  readonly lines: readonly LineProfile[]
  /** Library steps no user line accounts for (without just-my-code). */
  readonly libraryLineSteps: number
  /** The stack-path tree; the root is the top level. */
  readonly root: ProfileNode
  /** Paths with exclusive steps, in pre-order. */
  readonly folded: readonly FoldedStack[]
}

/** A stack path while it is being built. */
interface PathBuild {
  label: string
  name: string
  protoId: number
  library: boolean
  calls: number
  inclusive: number
  self: number
  firstEntry: number
  readonly children: Map<number, PathBuild>
}

interface FunctionBuild {
  name: string
  label: string
  protoId: number
  library: boolean
  lines: LineSpan | null
  calls: number
  inclusive: number
  exclusive: number
  total: number
  max: number
  firstEntry: number
}

/** Profiles a recording by steps (see the module comment). */
export function profile(recording: Recording, options: ProfileOptions = {}): Profile {
  const justMyCode = options.justMyCode ?? false
  const tree = callTree(recording)
  const treeOptions = { justMyCode }
  const lineIndex = new LineIndex(recording.program.source)
  const functions = new Map<number, FunctionBuild>()
  const paths = new Map<number, PathBuild>()
  let root: PathBuild | null = null
  for (const call of tree.calls(treeOptions)) {
    const steps = inclusiveSteps(recording, call)
    let own = steps
    for (const child of tree.children(call, treeOptions)) own -= inclusiveSteps(recording, child)
    const label = labelOf(tree, call, lineIndex)
    addCall(functions, call, label, steps, own, functionLines(recording, call, lineIndex))
    const parent = call.depth === 0 ? null : tree.parent(call, treeOptions)
    const path = pathFor(parent === null ? null : paths.get(parent.entry)!, call, label)
    path.calls += 1
    path.inclusive += steps
    path.self += own
    paths.set(call.entry, path)
    if (call.depth === 0) root = path
  }
  const rootPath = root ?? emptyPath(recording)
  addOutermostInclusive(rootPath, functions)
  const lineSteps = options.lines === false ? null : stepsPerLine(recording, justMyCode)
  return {
    steps: recording.length,
    justMyCode,
    functions: [...functions.values()].map(finishFunction).sort(byWeight),
    lines: lineSteps === null ? [] : lineSteps.lines,
    libraryLineSteps: lineSteps === null ? 0 : lineSteps.library,
    root: freeze(rootPath),
    folded: foldedStacks(rootPath),
  }
}

/** The steps of the call and everything it called. */
export function inclusiveSteps(recording: Recording, call: CallNode): number {
  return call.outcome === 'returned' ? call.exit - call.entry + 1 : recording.length - call.entry
}

function labelOf(tree: CallTree, call: CallNode, lineIndex: LineIndex): string {
  if (call.depth === 0) return '<top level>'
  if (call.name !== 'lambda' || call.library) return call.name
  const { program } = tree.recording
  const proto = program.protos[call.protoId - program.firstProtoId]
  return `lambda@${lineIndex.lineOf(proto?.debug.span.start ?? 0)}`
}

/** The first and last line of a user function in the main source; null for library code. */
function functionLines(
  recording: Recording,
  call: CallNode,
  lineIndex: LineIndex,
): LineSpan | null {
  const { program } = recording
  const proto = program.protos[call.protoId - program.firstProtoId]
  if (proto === undefined || proto.debug.source !== 'main') return null
  const { start, end } = proto.debug.span
  return { start: lineIndex.lineOf(start), end: lineIndex.lineOf(Math.max(start, end - 1)) }
}

function addCall(
  functions: Map<number, FunctionBuild>,
  call: CallNode,
  label: string,
  steps: number,
  own: number,
  lines: LineSpan | null,
): void {
  let entry = functions.get(call.protoId)
  if (entry === undefined) {
    entry = {
      name: call.depth === 0 ? '<top level>' : call.name,
      label,
      protoId: call.protoId,
      library: call.library,
      lines,
      calls: 0,
      inclusive: 0,
      exclusive: 0,
      total: 0,
      max: 0,
      firstEntry: call.entry,
    }
    functions.set(call.protoId, entry)
  }
  entry.calls += 1
  entry.exclusive += own
  entry.total += steps
  entry.max = Math.max(entry.max, steps)
}

function pathFor(parent: PathBuild | null, call: CallNode, label: string): PathBuild {
  const existing = parent?.children.get(call.protoId)
  if (existing !== undefined) return existing
  const path: PathBuild = {
    label,
    name: call.depth === 0 ? '<top level>' : call.name,
    protoId: call.protoId,
    library: call.library,
    calls: 0,
    inclusive: 0,
    self: 0,
    firstEntry: call.entry,
    children: new Map(),
  }
  parent?.children.set(call.protoId, path)
  return path
}

function emptyPath(recording: Recording): PathBuild {
  return {
    label: '<top level>',
    name: '<top level>',
    protoId: recording.program.script.id,
    library: false,
    calls: 1,
    inclusive: recording.length,
    self: recording.length,
    firstEntry: 0,
    children: new Map(),
  }
}

/**
 * A function's inclusive steps: the paths on which it is not already running further up, so a
 * recursive call is counted once (a depth-first walk with an explicit stack and counters).
 */
function addOutermostInclusive(root: PathBuild, functions: Map<number, FunctionBuild>): void {
  const running = new Map<number, number>()
  const work: { path: PathBuild; leaving: boolean }[] = [{ path: root, leaving: false }]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const { path } = item
    const active = running.get(path.protoId) ?? 0
    if (item.leaving) {
      running.set(path.protoId, active - 1)
      continue
    }
    if (active === 0) {
      const entry = functions.get(path.protoId)
      if (entry !== undefined) entry.inclusive += path.inclusive
    }
    running.set(path.protoId, active + 1)
    work.push({ path, leaving: true })
    const children = [...path.children.values()]
    for (let i = children.length - 1; i >= 0; i--) work.push({ path: children[i]!, leaving: false })
  }
}

function finishFunction(entry: FunctionBuild): FunctionProfile {
  return {
    name: entry.name,
    label: entry.label,
    protoId: entry.protoId,
    library: entry.library,
    lines: entry.lines,
    calls: entry.calls,
    inclusive: entry.inclusive,
    exclusive: entry.exclusive,
    average: entry.calls === 0 ? 0 : entry.total / entry.calls,
    max: entry.max,
    firstEntry: entry.firstEntry,
  }
}

function byWeight(a: FunctionProfile, b: FunctionProfile): number {
  return (
    b.inclusive - a.inclusive ||
    b.exclusive - a.exclusive ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
  )
}

/** An immutable copy of the path tree (children in order of their first call), built iteratively. */
function freeze(root: PathBuild): ProfileNode {
  const built = new Map<PathBuild, ProfileNode>()
  const work: { path: PathBuild; ready: boolean }[] = [{ path: root, ready: false }]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const children = [...item.path.children.values()].sort((x, y) => x.firstEntry - y.firstEntry)
    if (!item.ready) {
      work.push({ path: item.path, ready: true })
      for (const child of children) work.push({ path: child, ready: false })
      continue
    }
    const { path } = item
    built.set(path, {
      label: path.label,
      name: path.name,
      protoId: path.protoId,
      library: path.library,
      calls: path.calls,
      inclusive: path.inclusive,
      self: path.self,
      firstEntry: path.firstEntry,
      children: children.map((child) => built.get(child)!),
    })
  }
  return built.get(root)!
}

/** The paths with exclusive steps, `a;b;c` from the top level down, in pre-order. */
function foldedStacks(root: PathBuild): FoldedStack[] {
  const folded: FoldedStack[] = []
  const work: { path: PathBuild; prefix: string }[] = [{ path: root, prefix: '' }]
  for (let item = work.pop(); item !== undefined; item = work.pop()) {
    const stack = item.prefix === '' ? item.path.label : `${item.prefix};${item.path.label}`
    if (item.path.self > 0) folded.push({ stack, steps: item.path.self })
    const children = [...item.path.children.values()].sort((x, y) => x.firstEntry - y.firstEntry)
    for (let i = children.length - 1; i >= 0; i--) work.push({ path: children[i]!, prefix: stack })
  }
  return folded
}

/** The folded stacks as text, one `stack steps` line each (Brendan Gregg's format). */
export function foldedText(folded: readonly FoldedStack[]): string {
  return folded.map((entry) => `${entry.stack} ${entry.steps}`).join('\n')
}

/**
 * Steps per statement line: each step counts for the statement line of its instruction. With
 * just-my-code, a library step counts for the line the nearest user frame below it is running.
 */
function stepsPerLine(
  recording: Recording,
  justMyCode: boolean,
): { lines: LineProfile[]; library: number } {
  const counts = new Map<number, number>()
  const frameLine: number[] = []
  const frameUser: boolean[] = []
  let library = 0
  for (let t = 0; t < recording.length; t++) {
    const location = recording.locationAt(t)!
    const user = location.source === 'main'
    frameUser[location.depth] = user
    if (user) {
      frameLine[location.depth] = location.stmtLine
      counts.set(location.stmtLine, (counts.get(location.stmtLine) ?? 0) + 1)
      continue
    }
    let depth = location.depth - 1
    while (depth >= 0 && frameUser[depth] !== true) depth--
    const line = justMyCode && depth >= 0 ? frameLine[depth] : undefined
    if (line === undefined) library += 1
    else counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  const lines = [...counts]
    .map(([line, steps]) => ({ line, steps }))
    .sort((a, b) => b.steps - a.steps || a.line - b.line)
  return { lines, library }
}
