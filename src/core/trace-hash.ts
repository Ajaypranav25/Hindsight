/**
 * Trace fingerprints (ARCHITECTURE §7.14): a stable 64-bit FNV-1a hash of what a recording did (the
 * location of every step as proto id, ip, depth and opcode, the output each step printed, and how
 * the run ended), with checkpoints of the running hash so that a replay that behaves differently can say
 * where it starts to differ. Fingerprints are pure functions of the trace: the VM is deterministic,
 * so recording the same program with the same seed and step limit gives the same fingerprint.
 */
import type { Outcome, Recording } from './api-types'
import { replayAccess } from './recorder'

export const FINGERPRINT_PREFIX = 'fnv1a64:'
/** The most checkpoints a fingerprint keeps; longer runs space them out. */
export const MAX_CHECKPOINTS = 1024

/** The running hash after every `stride` steps (the last entry covers the remainder). */
export interface TraceCheckpoints {
  readonly stride: number
  /** `ceil(length / stride)` hashes of 16 lowercase hex digits. */
  readonly hashes: readonly string[]
}

export interface TraceFingerprint {
  /** `fnv1a64:` and 16 lowercase hex digits. */
  readonly fingerprint: string
  readonly checkpoints: TraceCheckpoints
}

/** Steps `from <= step < to` hold the first difference (`to = from + 1` when it is exact). */
export interface StepWindow {
  readonly from: number
  readonly to: number
}

const OFFSET_HI = 0xcbf29ce4
const OFFSET_LO = 0x84222325
/** The FNV 64-bit prime is 2^40 + 0x1b3. */
const PRIME_LO = 0x1b3
const TWO_32 = 4294967296

/** 64-bit FNV-1a over bytes, computed in two 32-bit halves. */
export class Fnv64 {
  private hi = OFFSET_HI
  private lo = OFFSET_LO

  byte(value: number): void {
    const lo = (this.lo ^ (value & 0xff)) >>> 0
    // (hi·2^32 + lo) · (2^40 + 0x1b3) mod 2^64: lo·0x1b3 stays below 2^41, so it is exact.
    const product = lo * PRIME_LO
    const carry = Math.floor(product / TWO_32)
    this.hi = (Math.imul(this.hi, PRIME_LO) + carry + (lo << 8)) >>> 0
    this.lo = product >>> 0
  }

  /** A 32-bit integer as four little-endian bytes (`byte` four times, unrolled for speed). */
  int32(value: number): void {
    let hi = this.hi
    let lo = this.lo
    for (let shift = 0; shift < 32; shift += 8) {
      lo = (lo ^ ((value >>> shift) & 0xff)) >>> 0
      const product = lo * PRIME_LO
      hi = (Math.imul(hi, PRIME_LO) + Math.floor(product / TWO_32) + (lo << 8)) >>> 0
      lo = product >>> 0
    }
    this.hi = hi
    this.lo = lo
  }

  /** A string as its length, then its UTF-16 code units (two bytes each). */
  text(value: string): void {
    this.int32(value.length)
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i)
      this.byte(unit)
      this.byte(unit >>> 8)
    }
  }

  hex(): string {
    return this.hi.toString(16).padStart(8, '0') + this.lo.toString(16).padStart(8, '0')
  }
}

/** The checkpoint spacing for a run of `length` steps. */
export function checkpointStride(length: number): number {
  return Math.max(1, Math.ceil(length / MAX_CHECKPOINTS))
}

/** Mixes the location of every step, read from the recorder's columns when possible. */
type StepMixer = (hash: Fnv64, t: number) => void

function stepMixer(recording: Recording): StepMixer {
  const access = replayAccess(recording)
  if (access === null) {
    // A recording from elsewhere (a test double): only what the public API says.
    return (hash, t) => {
      const location = recording.locationAt(t)
      hash.int32(location?.protoId ?? -1)
      hash.int32(location?.ip ?? -1)
      hash.int32(recording.depthAt(t))
      hash.int32(-1)
    }
  }
  const { protoIds, ips, depths } = access.core.steps
  let protoId = -1
  let code: readonly number[] = []
  return (hash, t) => {
    if (protoIds[t] !== protoId) {
      protoId = protoIds[t]!
      code = access.table.proto(protoId).code
    }
    hash.int32(protoId)
    hash.int32(ips[t]!)
    hash.int32(depths[t]!)
    hash.int32(code[ips[t]!]!)
  }
}

/** Mixes how the run ended: a step limit and an abort both leave the run paused at N. */
function mixOutcome(hash: Fnv64, outcome: Outcome): void {
  switch (outcome.kind) {
    case 'finished':
      hash.text('finished')
      return
    case 'error':
      hash.text('error')
      hash.text(outcome.error.code)
      hash.text(outcome.error.message)
      hash.int32(outcome.error.span.start)
      hash.int32(outcome.error.span.end)
      return
    default:
      hash.text('paused')
  }
}

/**
 * The fingerprint of a recording, with a checkpoint every `stride` steps (by default the spacing
 * `checkpointStride` gives for its length; pass a saved stride to compare with saved checkpoints).
 */
export function fingerprintRecording(
  recording: Recording,
  stride: number = checkpointStride(recording.length),
): TraceFingerprint {
  const hash = new Fnv64()
  const mixStep = stepMixer(recording)
  const outputs = recording.outputs
  const hashes: string[] = []
  let next = 0
  for (let t = 0; t < recording.length; t++) {
    mixStep(hash, t)
    while (next < outputs.length && outputs[next]!.time === t) hash.text(outputs[next++]!.text)
    if ((t + 1) % stride === 0 || t + 1 === recording.length) hashes.push(hash.hex())
  }
  hash.int32(recording.length)
  mixOutcome(hash, recording.outcome)
  return { fingerprint: FINGERPRINT_PREFIX + hash.hex(), checkpoints: { stride, hashes } }
}

/** What a saved trace says about its run: enough to locate a difference. */
export interface SavedTrace {
  readonly length: number
  readonly fingerprint: string
  readonly checkpoints: TraceCheckpoints
}

/**
 * Where a replay first differs from a saved trace, or null when the fingerprints agree. `replay`
 * must be fingerprinted with the saved stride.
 */
export function firstDifference(
  saved: SavedTrace,
  replay: TraceFingerprint,
  replayLength: number,
): StepWindow | null {
  if (saved.fingerprint === replay.fingerprint && saved.length === replayLength) return null
  const { stride } = saved.checkpoints
  const a = saved.checkpoints.hashes
  const b = replay.checkpoints.hashes
  const shorter = Math.min(saved.length, replayLength)
  const common = Math.min(a.length, b.length)
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) return { from: i * stride, to: Math.min((i + 1) * stride, shorter + 1) }
  }
  // Every shared window agrees: one run went on after the other ended, or only the ending differs.
  return { from: shorter, to: shorter + 1 }
}
