/**
 * Locations (ARCHITECTURE §7.4, api-types `Location`): the proto table of a recorded program, line
 * lookup in the main source and the prelude, and per-proto statement-line tables for navigation.
 */
import type { Location } from './api-types'
import { OP_NAMES, functionDisplayName, type FunctionProto, type Program } from './bytecode'
import { InternalError } from './diagnostics'
import { PRELUDE_SOURCE } from './prelude'
import { LineIndex, type Span } from './span'

/** Every proto a run can execute, indexed by id: library protos first, then the program's. */
export class ProtoTable {
  private readonly protos: (FunctionProto | undefined)[] = []
  private readonly mainLines: LineIndex
  private preludeLines: LineIndex | null = null
  private readonly stmtLineTables = new Map<number, Int32Array>()

  constructor(
    readonly program: Program,
    libraryProtos: readonly FunctionProto[],
  ) {
    for (const proto of libraryProtos) this.protos[proto.id] = proto
    for (const proto of program.protos) this.protos[proto.id] = proto
    this.mainLines = new LineIndex(program.source)
  }

  proto(id: number): FunctionProto {
    const proto = this.protos[id]
    if (proto === undefined) throw new InternalError(`no proto with id ${id}`)
    return proto
  }

  /** 1-based line of `offset` in the source the proto belongs to. */
  lineOf(proto: FunctionProto, offset: number): number {
    return this.linesFor(proto).lineOf(offset)
  }

  /** Per code index, the line of the statement span start (L(t) in §7.2). */
  stmtLines(proto: FunctionProto): Int32Array {
    let table = this.stmtLineTables.get(proto.id)
    if (table === undefined) {
      const lines = this.linesFor(proto)
      const starts = proto.debug.stmtSpanStart
      table = new Int32Array(proto.code.length)
      for (let ip = 0; ip < table.length; ip++) table[ip] = lines.lineOf(starts[ip] ?? 0)
      this.stmtLineTables.set(proto.id, table)
    }
    return table
  }

  private linesFor(proto: FunctionProto): LineIndex {
    if (proto.debug.source === 'main') return this.mainLines
    this.preludeLines ??= new LineIndex(PRELUDE_SOURCE)
    return this.preludeLines
  }
}

export function spanAtIp(proto: FunctionProto, ip: number): Span {
  const debug = proto.debug
  return { start: debug.spanStart[ip] ?? 0, end: debug.spanEnd[ip] ?? 0 }
}

export function stmtSpanAtIp(proto: FunctionProto, ip: number): Span {
  const debug = proto.debug
  return { start: debug.stmtSpanStart[ip] ?? 0, end: debug.stmtSpanEnd[ip] ?? 0 }
}

/** The `Location` of the instruction at `ip` of proto `protoId`, executing at `depth`. */
export function locationOf(
  table: ProtoTable,
  protoId: number,
  ip: number,
  depth: number,
): Location {
  const proto = table.proto(protoId)
  const debug = proto.debug
  const span = spanAtIp(proto, ip)
  const stmtSpan = stmtSpanAtIp(proto, ip)
  return {
    protoId,
    ip,
    depth,
    functionName: functionDisplayName(proto),
    source: debug.source,
    library: debug.library,
    span,
    stmtSpan,
    line: table.lineOf(proto, span.start),
    stmtLine: table.lineOf(proto, stmtSpan.start),
    stmtStart: debug.stmtStart[ip] === 1,
    opName: OP_NAMES[proto.code[ip] ?? -1] ?? '?',
  }
}
