/**
 * The run-versus-record cross-check (ARCHITECTURE §8, §10.2): a recording of a passing program must
 * produce the same outputs, the same number of steps and the same outcome as the fast run.
 */
import type {
  Outcome,
  OutputEvent,
  Recording,
  RunResult,
  RuntimeErrorInfo,
} from '../core/api-types'

/** What a recording must provide for the cross-check. */
export type RecordingSummary = Pick<Recording, 'length' | 'outcome' | 'outputs'>

export function compareRunWithRecording(run: RunResult, recording: RecordingSummary): string[] {
  const failures: string[] = []
  const outputDifference = compareOutputEvents(run.outputs, recording.outputs)
  if (outputDifference !== null) failures.push(`recording outputs differ: ${outputDifference}`)
  if (recording.length !== run.steps) {
    failures.push(`the recording has ${recording.length} steps but the run took ${run.steps}`)
  }
  const outcomeDifference = compareOutcomes(run.outcome, recording.outcome)
  if (outcomeDifference !== null) failures.push(`recording outcome differs: ${outcomeDifference}`)
  return failures
}

function compareOutputEvents(
  run: readonly OutputEvent[],
  recorded: readonly OutputEvent[],
): string | null {
  if (run.length !== recorded.length) {
    return `the run printed ${run.length} times, the recording ${recorded.length} times`
  }
  for (let i = 0; i < run.length; i++) {
    const a = run[i]!
    const b = recorded[i]!
    if (a.text !== b.text || a.time !== b.time) {
      return `event ${i + 1}: run ${describeEvent(a)}, recording ${describeEvent(b)}`
    }
  }
  return null
}

function describeEvent(event: OutputEvent): string {
  return `${JSON.stringify(event.text)} at time ${event.time}`
}

function compareOutcomes(run: Outcome, recorded: Outcome): string | null {
  if (run.kind !== recorded.kind) return `run ${run.kind}, recording ${recorded.kind}`
  if (run.kind === 'step-limit' && recorded.kind === 'step-limit') {
    return run.maxSteps === recorded.maxSteps
      ? null
      : `step limit ${run.maxSteps} versus ${recorded.maxSteps}`
  }
  if (run.kind === 'error' && recorded.kind === 'error') {
    return compareErrors(run.error, recorded.error)
  }
  return null
}

function compareErrors(run: RuntimeErrorInfo, recorded: RuntimeErrorInfo): string | null {
  const a = errorKey(run)
  const b = errorKey(recorded)
  return a === b ? null : `run error ${a}, recording error ${b}`
}

/** Everything observable about an error, as one comparable string. */
function errorKey(error: RuntimeErrorInfo): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    span: [error.span.start, error.span.end],
    time: error.time,
    stack: error.stack.map((entry) => [
      entry.name,
      entry.span.start,
      entry.span.end,
      entry.library,
    ]),
  })
}
