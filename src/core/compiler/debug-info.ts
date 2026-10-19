import type { DebugInfo, LocalInfo } from '../bytecode'
import type { FunctionState } from './function-state'

function byRange(a: LocalInfo, b: LocalInfo): number {
  return a.startIp - b.startIp || a.slot - b.slot || a.endIp - b.endIp
}

/** Freezes a function's debug tables into a `DebugInfo` (ARCHITECTURE §4.3.5). */
export function buildDebugInfo(fs: FunctionState): DebugInfo {
  const library = fs.ctx.mode === 'library'
  return {
    source: library ? 'prelude' : 'main',
    library,
    span: fs.setup.span,
    spanStart: Int32Array.from(fs.spanStart),
    spanEnd: Int32Array.from(fs.spanEnd),
    stmtStart: Uint8Array.from(fs.stmtStart),
    stmtSpanStart: Int32Array.from(fs.stmtSpanStart),
    stmtSpanEnd: Int32Array.from(fs.stmtSpanEnd),
    locals: [...fs.locals].sort(byRange),
    upvalueNames: fs.upvalues.map((u) => u.name),
  }
}
