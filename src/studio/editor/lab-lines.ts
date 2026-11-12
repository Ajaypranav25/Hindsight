/** Line sets the editor marks for negative provenance and fault localization (pure). */
import { LineIndex, type Recording, type WhyNot } from '../../core/index'

const idle = new WeakMap<Recording, ReadonlySet<number>>()

/**
 * The lines of the main source on which a statement starts but none ran in `recording`: the lines
 * "why didn't this run?" can be asked about (1-based).
 */
export function idleCodeLines(recording: Recording): ReadonlySet<number> {
  let lines = idle.get(recording)
  if (lines === undefined) {
    const { program } = recording
    const index = new LineIndex(program.source)
    const ran = recording.lineHitCounts()
    const found = new Set<number>()
    for (const proto of program.protos) {
      const { stmtStart, stmtSpanStart, stmtSpanEnd, source } = proto.debug
      if (source !== 'main') continue
      for (let ip = 0; ip < stmtStart.length; ip++) {
        // The program's closing instructions have an empty span at the end of the source.
        if (stmtStart[ip] !== 1 || stmtSpanEnd[ip]! <= stmtSpanStart[ip]!) continue
        const line = index.lineOf(stmtSpanStart[ip]!)
        if (!ran.has(line)) found.add(line)
      }
    }
    lines = found
    idle.set(recording, lines)
  }
  return lines
}

/** The step an explanation points at: where the decision was made, or where the run stopped. */
export function whyNotMoment(why: WhyNot): number | null {
  switch (why.kind) {
    case 'guard':
      return why.time
    case 'cut-short':
      return why.time
    case 'never-called':
      return why.callSite === null ? null : whyNotMoment(why.callSite)
    default:
      return null
  }
}

/** The line of the guard an explanation blames (also through a call site), or null. */
export function whyNotGuardLine(why: WhyNot): number | null {
  if (why.kind === 'guard') return why.guardLine
  return why.kind === 'never-called' && why.callSite !== null ? whyNotGuardLine(why.callSite) : null
}
