/**
 * What-if mode (ARCHITECTURE §7.5, §11.3): fork the shown run at the pen with one value changed,
 * show the fork next to the real run, and go back to the real run.
 */
import type { EditValue, Recording, WriteTarget } from '../../core/api-types'
import { formatLiteral } from '../../core/index'
import { formatCount } from '../lib/format'
import type {
  Engine,
  Notice,
  StudioState,
  StudioStore,
  WhatIfEditLabel,
  WhatIfState,
} from './types'

export interface WhatIfToken {
  aborted: boolean
}

/** What the flow needs from the store's controller. */
export interface WhatIfHost {
  get(): StudioStore
  set(patch: Partial<StudioState>): void
  readonly engine: Engine
  /** Starts tracking a recording; its token is the fork's abort signal. */
  begin(progress: number): WhatIfToken
  /** True when `token` is still the live recording (it then stops being in flight). */
  finish(token: WhatIfToken): boolean
  /** Aborts `token`'s recording if it is in flight and settles the status. */
  cancel(token: WhatIfToken): void
  progress(token: WhatIfToken, time: number): void
  completedStatus(): StudioState['status']
  notify(notice: Notice): void
  stopPlay(): void
  /** Called once a new recording is on screen. */
  displayed(): void
}

export const PEN_AT_END_NOTICE: Notice = {
  text: 'A what-if replays the future: move the pen back from the end first',
  tone: 'info',
}

export class WhatIfFlow {
  private pending: WhatIfToken | null = null

  constructor(private readonly host: WhatIfHost) {}

  /** Forks the shown recording at the pen with `target` set to `value` and shows the fork. */
  async fork(target: WriteTarget, value: EditValue, name: string): Promise<void> {
    const { recording, time, whatIf, status } = this.host.get()
    if (!recording || status.kind === 'recording') return
    if (time >= recording.length) return this.host.notify(PEN_AT_END_NOTICE)
    const parent = whatIf?.parent ?? recording
    const parentTime = whatIf?.parentTime ?? time
    const earlier = whatIf?.edits.filter((edit) => edit.time <= time) ?? []
    const token = this.host.begin(time)
    this.pending = token
    this.host.set({ status: { kind: 'recording', progress: time } })
    const result = await recording.forkAsync(
      time,
      { target, value },
      { signal: token, onProgress: (progress) => this.host.progress(token, progress) },
    )
    if (this.pending === token) this.pending = null
    if (!this.host.finish(token)) return
    if (!result.ok) {
      this.host.set({ status: this.host.completedStatus() })
      return this.host.notify({ text: `No what-if: ${result.error.message}`, tone: 'error' })
    }
    const edits = [...earlier, { time, text: `${name} = ${formatLiteral(value)}` }]
    const fork = result.recording
    this.host.stopPlay()
    this.host.set({
      recording: fork,
      status: this.host.completedStatus(),
      time,
      selectedFrameUid: null,
      originMark: null,
      whatIf: {
        parent,
        parentTime,
        edits,
        label: whatIfLabel(edits),
        comparison: this.host.engine.compare(parent, fork),
      },
    })
    this.host.displayed()
  }

  /** Restores the real run and its pen; a fork still recording is abandoned. */
  leave(): void {
    if (this.pending !== null) this.host.cancel(this.pending)
    this.pending = null
    const { whatIf } = this.host.get()
    if (!whatIf) return
    this.host.stopPlay()
    this.host.set({
      recording: whatIf.parent,
      time: Math.min(whatIf.parentTime, whatIf.parent.length),
      selectedFrameUid: null,
      originMark: null,
      whatIf: null,
    })
  }

  /** The what-if state once its fork was extended (the comparison changes with it). */
  extended(fork: Recording): WhatIfState | null {
    const { whatIf } = this.host.get()
    return whatIf && { ...whatIf, comparison: this.host.engine.compare(whatIf.parent, fork) }
  }
}

/** "total = 0 at step 3,500" for one edit, "2 edits" for more. */
export function whatIfLabel(edits: readonly WhatIfEditLabel[]): string {
  const only = edits.length === 1 ? edits[0]! : null
  return only ? `${only.text} at step ${formatCount(only.time)}` : `${edits.length} edits`
}

export interface WhatIfSummary {
  readonly head: string
  readonly divergence: string
  readonly output: string
}

/** The banner's sentences for a what-if whose fork is `fork`. */
export function whatIfSummary(whatIf: WhatIfState, fork: Recording): WhatIfSummary {
  const { comparison } = whatIf
  const divergence =
    comparison.divergence === null
      ? 'the futures do not diverge'
      : `diverges at step ${formatCount(comparison.divergence)}`
  const changed = Math.max(comparison.removed, comparison.added)
  const total = Math.max(whatIf.parent.outputs.length, fork.outputs.length)
  const output =
    changed === 0
      ? 'same output'
      : `${formatCount(changed)} of ${formatCount(total)} output ${total === 1 ? 'line' : 'lines'} changed`
  return { head: `What if ${whatIf.label}`, divergence, output }
}
