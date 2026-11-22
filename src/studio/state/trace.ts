/**
 * Opening `.sighttrace` files in the studio (ARCHITECTURE §7.15, §11.3): the file's program
 * replaces the editor's (keeping the user's own), is recorded again with the saved seed and step
 * limit, its what-if edits are re-applied, and the pen lands on the saved step. A replay that
 * differs from the saved run is explained in a notice.
 */
import type { Recording } from '../../core/api-types'
import {
  decodeTraceFile,
  formatLiteral,
  replayTraceAsync,
  type TraceBundle,
  type TraceReplay,
  writeName,
} from '../../core/index'
import { formatCount } from '../lib/format'
import type { WhatIfHost, WhatIfToken } from './what-if'
import { whatIfLabel } from './what-if'
import type { Notice, StudioState, WhatIfEditLabel, WhatIfState } from './types'

/** What the flow needs from the store's controller. */
export interface TraceHost extends Omit<WhatIfHost, 'cancel'> {
  /** Shows `source` in the editor without running it; true when the user's program was kept. */
  replace(source: string): boolean
}

/** Shown while a trace opens, when the program it replaces was kept. */
export const KEPT_AFTER_TRACE_NOTICE: Notice = {
  text: 'Opening a trace. Your previous program was kept.',
  tone: 'info',
  action: 'restore-previous',
}

/** The labels of a recording's what-if edits, as the what-if banner names them. */
export function traceEditLabels(recording: Recording): WhatIfEditLabel[] {
  return (recording.whatIf?.edits ?? []).map(({ time, edit }) => {
    const name =
      writeName(recording, { time, kind: 'write', target: edit.target, value: edit.value }) ??
      'a value'
    return { time, text: `${name} = ${formatLiteral(edit.value)}` }
  })
}

function whatIfState(host: TraceHost, base: Recording, recording: Recording): WhatIfState | null {
  if (recording === base) return null
  const edits = traceEditLabels(recording)
  return {
    parent: base,
    parentTime: edits[0]?.time ?? 0,
    edits,
    label: whatIfLabel(edits),
    comparison: host.engine.compare(base, recording),
  }
}

/** The notice once a trace is on screen. */
export function openedNotice(
  bundle: TraceBundle,
  replay: Extract<TraceReplay, { ok: true }>,
  kept: boolean,
): Notice {
  const keptText = kept ? ' Your previous program was kept.' : ''
  const action = kept ? { action: 'restore-previous' as const } : {}
  if (!replay.verification.verified)
    return { text: `${replay.verification.message}${keptText}`, tone: 'error', ...action }
  const name = bundle.title === null ? 'the trace' : `“${bundle.title}”`
  const edits = replay.recording.whatIf?.edits.length ?? 0
  const what = edits === 0 ? '' : ` with ${edits} what-if edit${edits === 1 ? '' : 's'}`
  return {
    text: `Opened ${name}${what} at step ${formatCount(replay.time)}.${keptText}`,
    tone: 'info',
    ...action,
  }
}

export class TraceFlow {
  constructor(private readonly host: TraceHost) {}

  /** Decodes a trace file and shows its run; problems become notices. */
  async open(bytes: Uint8Array): Promise<void> {
    const decoded = await decodeTraceFile(bytes)
    if (!decoded.ok)
      return this.host.notify({ text: `Could not open the trace: ${decoded.error}`, tone: 'error' })
    const { bundle } = decoded
    const kept = this.host.replace(bundle.source)
    const token: WhatIfToken = this.host.begin(0)
    if (this.host.get().compile?.ok !== false)
      this.host.set({ status: { kind: 'recording', progress: 0 } })
    const replay = await replayTraceAsync(this.host.engine, bundle, {
      signal: token,
      onProgress: (time) => this.host.progress(token, time),
    })
    if (!this.host.finish(token)) return
    if (!replay.ok) {
      this.host.set({ status: this.host.completedStatus() })
      this.host.displayed()
      return this.host.notify({ text: `Could not open the trace: ${replay.error}`, tone: 'error' })
    }
    this.host.stopPlay()
    const patch: Partial<StudioState> = {
      recording: replay.recording,
      recordedSource: bundle.source,
      status: this.host.completedStatus(),
      time: replay.time,
      selectedFrameUid: null,
      watch: null,
      originMark: null,
      whatIf: whatIfState(this.host, replay.base, replay.recording),
    }
    this.host.set(patch)
    this.host.displayed()
    this.host.notify(openedNotice(bundle, replay, kept))
  }
}
