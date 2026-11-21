/**
 * A persistent vector: a radix tree of 32-way nodes, used by snapshots to share structure
 * (ARCHITECTURE §6.8). A snapshot's object table and the items of large lists and records are
 * persistent vectors, so consecutive snapshots share every node that did not change.
 *
 * Every node records the `birth` serial of the edit that created it. An edit (`PVecEditor`) owns
 * the nodes born with its serial and changes them in place; any other node is copied before it is
 * changed (path copying), so the vector being edited is never affected. Births also tell which
 * nodes are new since an earlier version: a node that survives into a later version keeps its
 * birth, and a changed node's ancestors are all copied too, so walking down only into nodes born
 * after a serial finds exactly what was added after it (`freshNodes`).
 *
 * The tree height is at most 7 (32^7 > 2^31 indices), so the few recursive helpers below recurse
 * only that deep, never in proportion to user data.
 */
const BITS = 5
const WIDTH = 1 << BITS
const MASK = WIDTH - 1

/** A tree node: a leaf holds values, an inner node holds child nodes (sparse slots allowed). */
export class PNode {
  constructor(
    readonly birth: number,
    readonly slots: unknown[],
  ) {}
}

export class PVec<T> {
  private constructor(
    readonly length: number,
    /** Bits of index consumed above the leaves: 0 when the root is a leaf. */
    readonly shift: number,
    readonly root: PNode | null,
  ) {}

  private static readonly EMPTY = new PVec<never>(0, 0, null)

  static empty<T>(): PVec<T> {
    return PVec.EMPTY
  }

  /** A vector of `map(values[i])`, built leaf by leaf; all its nodes are born with `serial`. */
  static from<S, T>(values: readonly S[], serial: number, map: (value: S) => T): PVec<T> {
    const length = values.length
    if (length === 0) return PVec.EMPTY
    let level: PNode[] = []
    for (let start = 0; start < length; start += WIDTH) {
      const end = Math.min(length, start + WIDTH)
      const slots = new Array<unknown>(end - start)
      for (let i = start; i < end; i++) slots[i - start] = map(values[i] as S)
      level.push(new PNode(serial, slots))
    }
    let shift = 0
    while (level.length > 1) {
      const parents: PNode[] = []
      for (let start = 0; start < level.length; start += WIDTH) {
        parents.push(new PNode(serial, level.slice(start, start + WIDTH)))
      }
      level = parents
      shift += BITS
    }
    return new PVec<T>(length, shift, level[0]!)
  }

  /** The value at `index`, or undefined outside `0..length-1` or in a hole. */
  get(index: number): T | undefined {
    if (!(index >= 0 && index < this.length)) return undefined
    let node = this.root!
    for (let level = this.shift; level > 0; level -= BITS) {
      node = node.slots[(index >>> level) & MASK] as PNode
      if (node === undefined) return undefined
    }
    return node.slots[index & MASK] as T | undefined
  }

  /**
   * All values in index order, each passed through `map` (holes come out as `map(undefined)`), in
   * a packed array.
   */
  toArray<U>(map: (value: T) => U): U[] {
    const out: U[] = []
    if (this.root !== null)
      collect(this.root, this.shift, this.length, out, map as (v: unknown) => U)
    while (out.length < this.length) out.push(map(undefined as T))
    return out
  }

  /**
   * Calls `visit` with the slots of every leaf in index order (leaves may be shared: never change
   * them). Fastest way to read a whole vector; holes inside leaves come out as undefined.
   */
  forEachLeaf(visit: (slots: readonly T[]) => void): void {
    if (this.root !== null) visitLeaves(this.root, this.shift, visit as (slots: unknown[]) => void)
  }

  /** Calls `visit` with every value in index order, skipping holes. */
  forEach(visit: (value: T) => void): void {
    if (this.root !== null) visitValues(this.root, this.shift, visit as (value: unknown) => void)
  }

  /**
   * Calls `visit` for every node born after `serial` (see the module comment), telling whether it
   * is a leaf.
   */
  freshNodes(serial: number, visit: (node: PNode, leaf: boolean) => void): void {
    if (this.root !== null) visitFresh(this.root, this.shift, serial, visit)
  }

  /** The slots of all nodes born after `serial`: what this version stores beyond that one. */
  freshSlots(serial: number): number {
    let count = 0
    this.freshNodes(serial, (node) => {
      count += node.slots.length
    })
    return count
  }

  /**
   * Calls `visit` with every index at which `this` and `other` hold different values (by
   * identity; a hole differs from any value), descending only into nodes the two do not share. So
   * comparing two versions of one vector costs about the number of differences.
   */
  diff<U>(other: PVec<U>, visit: (index: number) => void): void {
    let a = this.root
    let b = other.root
    const shift = Math.max(this.shift, other.shift)
    // A shorter tree is the leftmost path of a taller one: lift it to the same height.
    for (let s = this.shift; s < shift && a !== null; s += BITS) a = new PNode(-1, [a])
    for (let s = other.shift; s < shift && b !== null; s += BITS) b = new PNode(-1, [b])
    if (a === null && b === null) return
    if (a === null || b === null) {
      // One side is empty: every index of the other differs.
      const length = a === null ? other.length : this.length
      for (let i = 0; i < length; i++) visit(i)
      return
    }
    diffNodes(a, b, shift, 0, visit)
  }

  /** An editor whose changes produce a new vector; nodes it creates are born with `serial`. */
  edit(serial: number): PVecEditor<T> {
    return new PVecEditor<T>(this.root, this.shift, this.length, serial)
  }

  /** Internal: wraps an editor's result. */
  static of<T>(length: number, shift: number, root: PNode | null): PVec<T> {
    return length === 0 ? PVec.EMPTY : new PVec<T>(length, shift, root)
  }
}

/** Appends the values under `node` to `out`, in order, until `out` holds `length` values. */
function collect<U>(
  node: PNode,
  shift: number,
  length: number,
  out: U[],
  map: (value: unknown) => U,
): void {
  const slots = node.slots
  if (shift === 0) {
    const end = Math.min(WIDTH, length - out.length)
    for (let i = 0; i < end; i++) out.push(map(slots[i]))
    return
  }
  for (let i = 0; i < WIDTH && out.length < length; i++) {
    const child = slots[i] as PNode | undefined
    if (child !== undefined) {
      collect(child, shift - BITS, length, out, map)
    } else {
      const end = Math.min(length, out.length + (1 << shift))
      while (out.length < end) out.push(map(undefined))
    }
  }
}

function diffNodes(
  a: PNode | undefined,
  b: PNode | undefined,
  shift: number,
  offset: number,
  visit: (index: number) => void,
): void {
  if (a === b) return
  const as = a?.slots ?? EMPTY_SLOTS
  const bs = b?.slots ?? EMPTY_SLOTS
  const count = Math.max(as.length, bs.length)
  if (shift === 0) {
    for (let i = 0; i < count; i++) if (as[i] !== bs[i]) visit(offset + i)
    return
  }
  for (let i = 0; i < count; i++) {
    diffNodes(
      as[i] as PNode | undefined,
      bs[i] as PNode | undefined,
      shift - BITS,
      offset + i * (1 << shift),
      visit,
    )
  }
}

const EMPTY_SLOTS: readonly unknown[] = []

function visitLeaves(node: PNode, shift: number, visit: (slots: unknown[]) => void): void {
  if (shift === 0) {
    visit(node.slots)
    return
  }
  for (const child of node.slots)
    if (child !== undefined) visitLeaves(child as PNode, shift - BITS, visit)
}

function visitValues(node: PNode, shift: number, visit: (value: unknown) => void): void {
  const slots = node.slots
  if (shift === 0) {
    for (const value of slots) if (value !== undefined) visit(value)
    return
  }
  for (const child of slots)
    if (child !== undefined) visitValues(child as PNode, shift - BITS, visit)
}

function visitFresh(
  node: PNode,
  shift: number,
  serial: number,
  visit: (node: PNode, leaf: boolean) => void,
): void {
  if (node.birth <= serial) return
  visit(node, shift === 0)
  if (shift === 0) return
  for (const child of node.slots) {
    if (child !== undefined) visitFresh(child as PNode, shift - BITS, serial, visit)
  }
}

/**
 * Batched changes to a persistent vector. Owned nodes (born with this editor's serial) are changed
 * in place; shared ones are copied first. `copied` counts the slots of the nodes this editor
 * copied or created (inner nodes too), i.e. what it stored afresh.
 */
export class PVecEditor<T> {
  copied = 0

  constructor(
    private root: PNode | null,
    private shift: number,
    private size: number,
    private readonly serial: number,
  ) {}

  get length(): number {
    return this.size
  }

  /** Sets `index`, growing the vector (with holes) when it lies beyond the end. */
  set(index: number, value: T): void {
    if (this.root === null) {
      this.root = new PNode(this.serial, [])
      this.shift = 0
    }
    while (index >>> this.shift >= WIDTH) {
      this.root = new PNode(this.serial, [this.root])
      this.shift += BITS
      this.copied += 1
    }
    let node = this.own(this.root)
    this.root = node
    for (let level = this.shift; level > 0; level -= BITS) {
      const slot = (index >>> level) & MASK
      const child = node.slots[slot] as PNode | undefined
      const owned = child === undefined ? new PNode(this.serial, []) : this.own(child)
      if (owned !== child) this.store(node, slot, owned)
      node = owned
    }
    this.store(node, index & MASK, value)
    if (index >= this.size) this.size = index + 1
  }

  /** Writes a slot of an owned node, counting the slots it adds. */
  private store(node: PNode, slot: number, value: unknown): void {
    if (slot >= node.slots.length) this.copied += slot + 1 - node.slots.length
    node.slots[slot] = value
  }

  /** Appends `value` at the end. */
  push(value: T): void {
    this.set(this.size, value)
  }

  /** Drops every value at or after `length`. */
  truncate(length: number): void {
    if (length >= this.size) return
    if (length <= 0 || this.root === null) {
      this.root = null
      this.shift = 0
      this.size = 0
      return
    }
    const last = length - 1
    while (this.shift > 0 && last >>> this.shift === 0) {
      this.root = this.root.slots[0] as PNode
      this.shift -= BITS
    }
    let node = this.own(this.root)
    this.root = node
    for (let level = this.shift; level > 0; level -= BITS) {
      const slot = (last >>> level) & MASK
      node.slots.length = slot + 1
      const owned = this.own(node.slots[slot] as PNode)
      node.slots[slot] = owned
      node = owned
    }
    node.slots.length = (last & MASK) + 1
    this.size = length
  }

  build(): PVec<T> {
    return PVec.of<T>(this.size, this.shift, this.root)
  }

  private own(node: PNode): PNode {
    if (node.birth === this.serial) return node
    this.copied += node.slots.length
    return new PNode(this.serial, node.slots.slice())
  }
}
