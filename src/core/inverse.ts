/**
 * The inverse what-if (ARCHITECTURE §7.11). A what-if runs forwards: set a value, watch the new
 * future. This runs it backwards: name the future ("make this line print 100", "make this crash
 * not happen") and it finds a past that produces it.
 *
 * 1. **Candidates**: the backward slice of the target gives the writes it was computed from
 *    (`upstreamWrites`); each `let`/`var` declaration or parameter among them that held a number
 *    or a boolean is a candidate, at the step just after it got that value.
 * 2. **Search**, one candidate at a time (coordinate descent): forks are cheap and deterministic,
 *    so the output is treated as a function of the candidate's value. A first probe tells whether
 *    the target moves at all; then the secant method homes in, switching to bisection once two
 *    values bracket the goal. Goals without a number to steer by (a crash, a text) are probed with
 *    a few nearby values.
 *
 * The search is a generator that asks for forks and receives them, so the same code runs
 * synchronously (the CLI, tests) and in slices that keep a page responsive (`forkAsync`).
 */
import type {
  AsyncForkOptions,
  EditValue,
  ForkEdit,
  ForkResult,
  Recording,
  WriteTarget,
} from './api-types'
import { formatLiteral } from './literal'
import { backwardSlice, upstreamWrites } from './slice'

export type InverseGoal =
  /** Output line `index` (0-based, in `recording.outputs`) should read `text`. */
  | { readonly kind: 'output'; readonly index: number; readonly text: string }
  /** The run should not fail the way it did. */
  | { readonly kind: 'no-error' }

export interface InverseCandidate {
  /** The fork step: just after the write that gave the value. */
  readonly time: number
  readonly target: WriteTarget
  /** The variable's or parameter's name. */
  readonly name: string
  /** The line that wrote the value, when it is user code. */
  readonly line: number | null
  readonly original: number | boolean
}

export interface InverseSolution {
  readonly candidate: InverseCandidate
  readonly value: EditValue
  /** "If rate at step 412 had been 0.15 instead of 0.2, line 42 would have printed 100." */
  readonly sentence: string
}

export interface InverseResult {
  /** Best first: the smallest change to the original value. */
  readonly solutions: readonly InverseSolution[]
  /** Candidates tried. */
  readonly candidates: number
  /** Forks run. */
  readonly forks: number
  /** True when the fork budget ran out before every candidate was tried. */
  readonly exhausted: boolean
  /** Why nothing could be searched, when that is so. */
  readonly problem: string | null
}

export interface InverseOptions {
  /** The most forks run in all. Default 300. */
  readonly maxForks?: number
  /** Stop after this many solutions. Default 3. */
  readonly maxSolutions?: number
  /** The most candidates tried. Default 24. */
  readonly maxCandidates?: number
}

export interface ForkRequest {
  readonly time: number
  readonly edit: ForkEdit
  /** The step limit for this fork: a changed loop bound must not run for ever. */
  readonly maxSteps: number
}

export type InverseSearch = Generator<ForkRequest, InverseResult, ForkResult>

const DEFAULT_MAX_FORKS = 300
const DEFAULT_MAX_SOLUTIONS = 3
const DEFAULT_MAX_CANDIDATES = 24
const MAX_SECANT_STEPS = 12
const MAX_BISECTIONS = 48
/** Significant digits tried, roundest first, when a solution is not a whole number. */
const ROUNDINGS = [1, 2, 3, 4, 6, 9]
const NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi

/** Runs the search to the end with synchronous forks. */
export function solveInverse(
  recording: Recording,
  goal: InverseGoal,
  options: InverseOptions = {},
): InverseResult {
  const search = inverseSearch(recording, goal, options)
  let next = search.next()
  while (next.done !== true) {
    const { time, edit, maxSteps } = next.value
    next = search.next(recording.fork(time, edit, { maxSteps }))
  }
  return next.value
}

/** Runs the search with sliced forks; an aborted signal ends it with what was found so far. */
export async function solveInverseAsync(
  recording: Recording,
  goal: InverseGoal,
  options: InverseOptions & Pick<AsyncForkOptions, 'signal' | 'sliceMs'> = {},
): Promise<InverseResult> {
  const search = inverseSearch(recording, goal, options)
  let next = search.next()
  while (next.done !== true) {
    const { time, edit, maxSteps } = next.value
    const fork = await recording.forkAsync(time, edit, {
      maxSteps,
      signal: options.signal,
      sliceMs: options.sliceMs,
    })
    if (options.signal?.aborted === true) {
      return { solutions: [], candidates: 0, forks: 0, exhausted: true, problem: 'Stopped.' }
    }
    next = search.next(fork)
  }
  return next.value
}

// --- the goal -----------------------------------------------------------------------------------

interface Reading {
  readonly solved: boolean
  /** How far the measured number is from the goal (signed); null when there is none to measure. */
  readonly residual: number | null
  /** The number the goal steers, as this run printed it. */
  readonly measured?: number
}

interface Target {
  /** The step whose slice gives the candidates. */
  readonly criterion: number
  read(fork: Recording): Reading
  /** What a solved run did, for the sentence: "line 4 would have printed 100". */
  describe(fork: Recording): string
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(NUMBER)].map((match) => Number(match[0]))
}

function skeleton(text: string): string {
  return text.replace(NUMBER, '#')
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

function outputTarget(recording: Recording, index: number, text: string): Target | string {
  const real = recording.outputs[index]
  if (real === undefined) return `There is no output line ${index + 1}.`
  const wanted = text.trim()
  const wantedNumbers = numbersIn(wanted)
  const plainNumber = wantedNumbers.length === 1 && skeleton(wanted) === '#'
  // Which number of the line to steer: the only one the goal names, or the one it changes.
  const realNumbers = numbersIn(real.text)
  const sameShape = skeleton(real.text) === skeleton(wanted)
  const position = plainNumber
    ? -1
    : sameShape
      ? wantedNumbers.findIndex((value, i) => !close(value, realNumbers[i] ?? NaN))
      : -2
  const goalNumber = plainNumber ? wantedNumbers[0]! : (wantedNumbers[position] ?? null)
  const line = recording.locationAt(real.time)?.line ?? null
  const where = line === null ? `output line ${index + 1}` : `line ${line}`
  return {
    criterion: real.time,
    read(fork) {
      const printed = fork.outputs[index]?.text
      if (printed === undefined) return { solved: false, residual: null }
      if (printed.trim() === wanted) return { solved: true, residual: 0 }
      if (goalNumber === null) return { solved: false, residual: null }
      const numbers = numbersIn(printed)
      if (!plainNumber && skeleton(printed) !== skeleton(wanted)) {
        return { solved: false, residual: null }
      }
      const measured = plainNumber ? numbers.at(-1) : numbers[position]
      if (measured === undefined || Number.isNaN(measured)) return { solved: false, residual: null }
      // A plain number is a goal for the value, wherever the line shows it. A whole line is
      // reached when every number in it is (arithmetic prints 99.99999999999996 for 100).
      const solved = plainNumber
        ? close(measured, goalNumber)
        : numbers.length === wantedNumbers.length &&
          numbers.every((value, i) => close(value, wantedNumbers[i]!))
      return { solved, residual: measured - goalNumber, measured }
    },
    describe() {
      return `${where} would have printed ${wanted}`
    },
  }
}

function noErrorTarget(recording: Recording): Target | string {
  const outcome = recording.outcome
  if (outcome.kind !== 'error') return 'The run did not fail, so there is no error to avoid.'
  const { code, span } = outcome.error
  const failedLine = recording.locationAt(recording.length)?.line ?? null
  const failed = failedLine === null ? 'where it did' : `on line ${failedLine}`
  return {
    criterion: recording.length,
    read(fork) {
      const now = fork.outcome
      const same =
        now.kind === 'error' && now.error.code === code && now.error.span.start === span.start
      return { solved: !same, residual: null }
    },
    describe(fork) {
      const now = fork.outcome
      const then =
        now.kind === 'finished'
          ? 'it would have finished normally'
          : now.kind === 'error'
            ? `it would have got further and failed with ${now.error.code}: ${now.error.message}`
            : 'it would have kept running to the step limit'
      return `the run would not have failed ${failed}: ${then}`
    },
  }
}

// --- candidates ---------------------------------------------------------------------------------

function candidatesOf(recording: Recording, criterion: number, limit: number): InverseCandidate[] {
  const slice = backwardSlice(recording, criterion)
  if (slice === null) return []
  // The latest value of each place: the one the target was computed from.
  const latest = new Map<string, InverseCandidate>()
  for (const { event, name, line } of upstreamWrites(recording, slice)) {
    const { value, target } = event
    if (typeof value !== 'number' && typeof value !== 'boolean') continue
    // Declarations and parameters only: the inputs of the computation, not its partial results
    // (setting the printed value itself would always "work" and explain nothing).
    if (event.kind !== 'declare' || name === null) continue
    if (target.kind !== 'local' && target.kind !== 'global') continue
    if (event.time >= criterion || event.time + 1 >= recording.length) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    const site = recording.locationAt(event.time)
    const key = `${site?.protoId ?? -1}:${site?.ip ?? -1}:${name}`
    latest.set(key, { time: event.time + 1, target, name, line, original: value })
  }
  // The nearest first: their forks replay the least.
  return [...latest.values()].sort((a, b) => b.time - a.time).slice(0, limit)
}

// --- the search ---------------------------------------------------------------------------------

export function* inverseSearch(
  recording: Recording,
  goal: InverseGoal,
  options: InverseOptions = {},
): InverseSearch {
  const maxForks = options.maxForks ?? DEFAULT_MAX_FORKS
  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS
  const found =
    goal.kind === 'output'
      ? outputTarget(recording, goal.index, goal.text)
      : noErrorTarget(recording)
  const nothing = (problem: string): InverseResult => ({
    solutions: [],
    candidates: 0,
    forks: 0,
    exhausted: false,
    problem,
  })
  if (typeof found === 'string') return nothing(found)
  // A constant of its own type: the generators below close over it.
  const target: Target = found
  if (target.read(recording).solved) return nothing('The run already does that.')
  const candidates = candidatesOf(
    recording,
    target.criterion,
    options.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  )
  if (candidates.length === 0) {
    return nothing('No number or true/false value the program stored leads to that moment.')
  }
  const real = target.read(recording).residual
  const maxSteps = Math.max(recording.length * 4, recording.length + 100_000)
  const solutions: InverseSolution[] = []
  let forks = 0
  let tried = 0
  let exhausted = false

  type Attempt = { readonly reading: Reading; readonly outcome: string }

  /** One fork: the run with `candidate` set to `value`; null when the budget is spent. */
  function* attempt(
    candidate: InverseCandidate,
    value: EditValue,
  ): Generator<ForkRequest, Attempt | null, ForkResult> {
    if (forks >= maxForks) {
      exhausted = true
      return null
    }
    forks += 1
    const edit = { target: candidate.target, value }
    const result = yield { time: candidate.time, edit, maxSteps }
    if (!result.ok) return { reading: { solved: false, residual: null }, outcome: '' }
    const reading = target.read(result.recording)
    return { reading, outcome: reading.solved ? target.describe(result.recording) : '' }
  }

  /** A fork's reading; a value that reaches the goal is recorded as a solution. */
  function* probe(
    candidate: InverseCandidate,
    value: EditValue,
  ): Generator<ForkRequest, Reading | null, ForkResult> {
    let found = yield* attempt(candidate, value)
    if (found === null || !found.reading.solved) return found?.reading ?? null
    let best = value
    // Arithmetic lands on 0.5000000000000002: prefer the roundest value that still works.
    if (typeof value === 'number' && !Number.isInteger(value)) {
      for (const digits of ROUNDINGS) {
        const rounded: number = Number(value.toPrecision(digits))
        if (rounded === value) break
        const again: Attempt | null = yield* attempt(candidate, rounded)
        if (again === null) break
        if (again.reading.solved) {
          found = again
          best = rounded
          break
        }
      }
    }
    solutions.push({ candidate, value: best, sentence: sentenceOf(candidate, best, found.outcome) })
    return found.reading
  }

  const printed = target.read(recording).measured
  for (const candidate of candidates) {
    if (solutions.length >= maxSolutions || exhausted) break
    // A variable that merely holds the printed number explains nothing: setting it always works.
    const { original } = candidate
    if (printed !== undefined && typeof original === 'number' && close(original, printed)) continue
    tried += 1
    if (typeof candidate.original === 'boolean') {
      yield* probe(candidate, !candidate.original)
    } else if (real === null) {
      yield* nearby(candidate, candidate.original, probe)
    } else {
      yield* descend(candidate, candidate.original, real, probe)
    }
  }
  const change = (solution: InverseSolution): number => {
    const { original } = solution.candidate
    if (typeof original !== 'number' || typeof solution.value !== 'number') return 1
    return Math.abs(solution.value - original) / Math.max(1, Math.abs(original))
  }
  return {
    solutions: [...solutions].sort((a, b) => change(a) - change(b)),
    candidates: tried,
    forks,
    exhausted,
    problem: null,
  }
}

type Probe = (
  candidate: InverseCandidate,
  value: EditValue,
) => Generator<ForkRequest, Reading | null, ForkResult>

/** Values near `original`, for goals with nothing to measure. Stops at the first that works. */
function* nearby(
  candidate: InverseCandidate,
  original: number,
  probe: Probe,
): Generator<ForkRequest, void, ForkResult> {
  const whole = Number.isInteger(original)
  const values = [
    original - 1,
    original + 1,
    0,
    1,
    whole ? Math.trunc(original / 2) : original / 2,
    original * 2,
    -original,
  ]
  const seen = new Set<number>([original])
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    const reading = yield* probe(candidate, value)
    if (reading === null || reading.solved) return
  }
}

/** The secant method on the residual, then bisection once the goal is bracketed. */
function* descend(
  candidate: InverseCandidate,
  original: number,
  real: number,
  probe: Probe,
): Generator<ForkRequest, void, ForkResult> {
  const whole = Number.isInteger(original)
  const first = whole ? 1 : Math.max(Math.abs(original) * 0.1, 0.01)
  let a = { x: original, r: real }
  let b: { x: number; r: number } | null = null
  // Does the target move at all when this value does?
  for (const x of [original + first, original - first, original * 2 + first]) {
    const reading: Reading | null = yield* probe(candidate, x)
    if (reading === null || reading.solved) return
    if (reading.residual !== null && reading.residual !== real) {
      b = { x, r: reading.residual }
      break
    }
  }
  if (b === null) return
  for (let i = 0; i < MAX_SECANT_STEPS; i++) {
    if (Math.sign(a.r) !== Math.sign(b.r)) {
      yield* bisect(candidate, a, b, whole, probe)
      return
    }
    if (a.r === b.r) return
    let x: number = b.x - (b.r * (b.x - a.x)) / (b.r - a.r)
    if (whole) x = Math.round(x)
    if (!Number.isFinite(x) || x === a.x || x === b.x) return
    const reading: Reading | null = yield* probe(candidate, x)
    if (reading === null || reading.solved || reading.residual === null) return
    a = b
    b = { x, r: reading.residual }
  }
}

function* bisect(
  candidate: InverseCandidate,
  from: { x: number; r: number },
  to: { x: number; r: number },
  whole: boolean,
  probe: Probe,
): Generator<ForkRequest, void, ForkResult> {
  let low = from
  let high = to
  for (let i = 0; i < MAX_BISECTIONS; i++) {
    // Where a straight line between the ends would cross zero, kept away from the ends so the
    // bracket always shrinks; whole numbers stay whole.
    const span = high.x - low.x
    let x: number = low.x - (low.r * span) / (high.r - low.r)
    if (whole) {
      x = Math.round(x)
      if (x === low.x || x === high.x) x = Math.trunc((low.x + high.x) / 2)
      if (x === low.x || x === high.x) return
    } else {
      const least = Math.min(low.x, high.x)
      const most = Math.max(low.x, high.x)
      if (most - least < 1e-12 * Math.max(1, Math.abs(least))) return
      const margin = (most - least) * 0.01
      if (!(x > least + margin && x < most - margin)) x = (least + most) / 2
    }
    const reading: Reading | null = yield* probe(candidate, x)
    if (reading === null || reading.solved || reading.residual === null) return
    if (Math.sign(reading.residual) === Math.sign(low.r)) low = { x, r: reading.residual }
    else high = { x, r: reading.residual }
  }
}

function sentenceOf(candidate: InverseCandidate, value: EditValue, outcome: string): string {
  const step = `step ${candidate.time.toLocaleString('en-US')}`
  return `If ${candidate.name} at ${step} had been ${formatLiteral(value)} instead of ${formatLiteral(candidate.original)}, ${outcome}.`
}
