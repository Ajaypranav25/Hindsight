/**
 * The inspector (ARCHITECTURE §7.4): builds a `StateView` from a VM positioned at time t. Used by
 * recordings on their replay VM and, in tests, on a fresh VM run to the same time.
 */
import type {
  FrameView,
  GlobalView,
  LocalView,
  Location,
  RuntimeErrorInfo,
  StateView,
  ValueView,
} from './api-types'
import { functionDisplayName, type LocalInfo } from './bytecode'
import { InternalError } from './diagnostics'
import type { Frame, Value, VM } from './runtime-types'
import { captureViews, valueView, walkHeap } from './inspector-heap'
import { type ProtoTable, spanAtIp, stmtSpanAtIp } from './inspector-location'

export interface ViewContext {
  readonly table: ProtoTable
  readonly heapLimit: number
}

/** What the recording knows about time t besides the VM state. */
export interface ViewMoment {
  readonly time: number
  readonly location: Location | null
  readonly outputCount: number
  readonly error: RuntimeErrorInfo | null
}

export function buildStateView(vm: VM, context: ViewContext, moment: ViewMoment): StateView {
  const { heap, truncated } = walkHeap(vm, context.heapLimit)
  return {
    time: moment.time,
    location: moment.location,
    frames: frameViews(vm, context.table),
    globals: globalViews(vm),
    heap,
    heapTruncated: truncated,
    outputCount: moment.outputCount,
    error: moment.error,
  }
}

function frameViews(vm: VM, table: ProtoTable): FrameView[] {
  const frames = vm.frames
  return frames.map((frame, index) => {
    const top = index === frames.length - 1
    const regionEnd = top ? vm.stack.length : frames[index + 1]!.base
    return frameView(vm, table, frame, top, regionEnd)
  })
}

function frameView(
  vm: VM,
  table: ProtoTable,
  frame: Frame,
  top: boolean,
  regionEnd: number,
): FrameView {
  const proto = frame.closure.proto
  const debug = proto.debug
  // A caller shows the call it is waiting on: the instruction just before its ip.
  const spanIp = top ? frame.ip : frame.ip - 1
  const span = spanAtIp(proto, spanIp)
  const live = liveLocals(debug.locals, frame, regionEnd)
  const highestSlot = live.reduce((max, local) => Math.max(max, local.slot), 0)
  const temps: ValueView[] = []
  for (let index = frame.base + highestSlot + 1; index < regionEnd; index++) {
    temps.push(valueView(vm.stack[index] as Value))
  }
  return {
    uid: frame.uid,
    name: functionDisplayName(proto),
    protoId: proto.id,
    ip: frame.ip,
    library: debug.library,
    source: debug.source,
    span,
    stmtSpan: stmtSpanAtIp(proto, spanIp),
    line: table.lineOf(proto, span.start),
    locals: live.filter((local) => !local.hidden).map((local) => localView(vm, frame, local)),
    captures: captureViews(vm, frame.closure),
    temps,
  }
}

/** Locals live at the frame's ip and inside its current stack region, one per slot, slot order. */
function liveLocals(locals: readonly LocalInfo[], frame: Frame, regionEnd: number): LocalInfo[] {
  const bySlot = new Map<number, LocalInfo>()
  for (const local of locals) {
    if (local.startIp > frame.ip || frame.ip >= local.endIp) continue
    if (frame.base + local.slot >= regionEnd) continue
    const existing = bySlot.get(local.slot)
    if (existing === undefined || existing.startIp < local.startIp) bySlot.set(local.slot, local)
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
}

function localView(vm: VM, frame: Frame, local: LocalInfo): LocalView {
  return {
    name: local.name,
    slot: local.slot,
    kind: local.kind,
    mutable: local.mutable,
    value: valueView(vm.stack[frame.base + local.slot] as Value),
    declSpan: local.declSpan,
    target: { kind: 'local', frameUid: frame.uid, slot: local.slot },
  }
}

function globalViews(vm: VM): GlobalView[] {
  const infos = new Map(vm.program.globals.map((info) => [info.name, info]))
  const views: GlobalView[] = []
  for (const [name, value] of vm.globals) {
    const info = infos.get(name)
    if (info === undefined) throw new InternalError(`global '${name}' is not declared`)
    views.push({
      name,
      kind: info.kind,
      mutable: info.mutable,
      value: valueView(value),
      declSpan: info.declSpan,
      target: { kind: 'global', name },
    })
  }
  return views
}
