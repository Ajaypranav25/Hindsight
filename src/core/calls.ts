/**
 * The call tree of a recording (ARCHITECTURE §7.6), the ground the bug finder walks. The root is
 * the whole program; a call's children are the calls it made, in execution order. The shape comes
 * from one pass over `depthSeries()` on first use; nodes and their details (which need state
 * seeks) are built only for the calls asked about, and cached. Built on the public Recording API.
 */
import type { Recording } from './api-types'
import { type CallDetails, callDetails } from './call-details'
import { buildCallIndex, type CallIndex } from './calls-index'
import { InternalError } from './diagnostics'

export type { CallArgument, CallDetails, CallValue, LineSpan } from './call-details'

/**
 * `returned`: the call came back. `raised`: the run ended with an error while it was running.
 * `unfinished`: the recording stopped (step limit or abort) while it was running.
 */
export type CallOutcome = 'returned' | 'raised' | 'unfinished'

export interface CallNode {
  /** The call's entry step; unique per call (0 for the root). */
  readonly id: number
  /** The callee's first step (0 for the root). */
  readonly entry: number
  /** The call's last step: its `Return` when it returned, else N (where the run stopped). */
  readonly exit: number
  /** Frame depth of the callee (0 for the root, the top-level script). */
  readonly depth: number
  readonly outcome: CallOutcome
  readonly protoId: number
  /** Display name: a function name, `lambda`, or `<top level>`. */
  readonly name: string
  /** Library (prelude) code. */
  readonly library: boolean
}

export interface CallTreeOptions {
  /** Hide library calls, lifting the user calls they make to the nearest user-code caller. */
  readonly justMyCode?: boolean
}

const trees = new WeakMap<Recording, CallTree>()

/** The call tree of `recording`, shared by every caller. */
export function callTree(recording: Recording): CallTree {
  let tree = trees.get(recording)
  if (tree === undefined) {
    tree = new CallTree(recording)
    trees.set(recording, tree)
  }
  return tree
}

export class CallTree {
  private shape: CallIndex | null = null
  private readonly nodes = new Map<number, CallNode>()
  /** Call index by entry step, for every node handed out. */
  private readonly indexes = new Map<number, number>()
  private readonly allChildren = new Map<number, readonly CallNode[]>()
  private readonly userChildren = new Map<number, readonly CallNode[]>()
  private readonly detailCache = new Map<number, CallDetails>()

  constructor(readonly recording: Recording) {}

  get root(): CallNode {
    return this.node(0)
  }

  /** The call that begins at step `entry`, or null. */
  call(entry: number): CallNode | null {
    const index = this.index().indexOfEntry(entry)
    return index < 0 ? null : this.node(index)
  }

  children(call: CallNode, options: CallTreeOptions = {}): readonly CallNode[] {
    const index = this.indexOf(call)
    const cache = options.justMyCode === true ? this.userChildren : this.allChildren
    let children = cache.get(index)
    if (children === undefined) {
      children = options.justMyCode === true ? this.userChildrenOf(index) : this.childrenOf(index)
      cache.set(index, children)
    }
    return children
  }

  /** The calling call (with just-my-code, the nearest user-code one); null for the root. */
  parent(call: CallNode, options: CallTreeOptions = {}): CallNode | null {
    let index = this.index().parentOf(this.indexOf(call))
    while (index > 0 && options.justMyCode === true && this.node(index).library) {
      index = this.index().parentOf(index)
    }
    return index < 0 ? null : this.node(index)
  }

  /** The innermost call running at time `t` (with just-my-code, the innermost user call). */
  callAt(t: number, options: CallTreeOptions = {}): CallNode {
    if (!Number.isInteger(t) || t < 0 || t > this.recording.length) {
      throw new InternalError(`time ${t} is outside the recording`)
    }
    let index = this.index().innermostAt(t)
    while (index > 0 && options.justMyCode === true && this.node(index).library) {
      index = this.index().parentOf(index)
    }
    return this.node(index)
  }

  details(call: CallNode): CallDetails {
    const index = this.indexOf(call)
    let details = this.detailCache.get(index)
    if (details === undefined) {
      details = callDetails(this.recording, call)
      this.detailCache.set(index, details)
    }
    return details
  }

  /** The memoization key of the call (see `CallDetails.key`). */
  keyOf(call: CallNode): string | null {
    return this.details(call).key
  }

  private index(): CallIndex {
    this.shape ??= buildCallIndex(this.recording.depthSeries(), this.recording.length)
    return this.shape
  }

  private indexOf(call: CallNode): number {
    const index = this.indexes.get(call.entry)
    if (index === undefined || this.nodes.get(index) !== call) {
      throw new InternalError(`call ${call.id} does not belong to this recording`)
    }
    return index
  }

  private childrenOf(index: number): CallNode[] {
    return this.index()
      .childrenOf(index)
      .map((child) => this.node(child))
  }

  /** User calls below `index`, looking through library calls (an explicit work stack). */
  private userChildrenOf(index: number): CallNode[] {
    const found: CallNode[] = []
    const work = this.index().childrenOf(index).reverse()
    while (work.length > 0) {
      const child = work.pop()!
      const node = this.node(child)
      if (!node.library) {
        found.push(node)
        continue
      }
      const below = this.index().childrenOf(child)
      for (let i = below.length - 1; i >= 0; i--) work.push(below[i]!)
    }
    return found
  }

  private node(index: number): CallNode {
    let node = this.nodes.get(index)
    if (node === undefined) {
      node = this.buildNode(index)
      this.nodes.set(index, node)
      this.indexes.set(node.entry, index)
    }
    return node
  }

  private buildNode(index: number): CallNode {
    const { recording } = this
    const entry = this.index().entryOf(index)
    const end = this.index().endOf(index)
    const outcome = this.outcomeOf(end)
    const location = recording.locationAt(entry)
    const script = recording.program.script
    return {
      id: entry,
      entry,
      exit: outcome === 'returned' ? end - 1 : recording.length,
      depth: index === 0 ? 0 : recording.depthAt(entry),
      outcome,
      protoId: location?.protoId ?? script.id,
      name: location?.functionName ?? '<top level>',
      library: location?.library ?? false,
    }
  }

  private outcomeOf(end: number): CallOutcome {
    const { recording } = this
    if (end < recording.length) return 'returned'
    switch (recording.outcome.kind) {
      case 'finished':
        return 'returned'
      case 'error':
        return 'raised'
      default:
        return 'unfinished'
    }
  }
}
