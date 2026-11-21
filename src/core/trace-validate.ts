/**
 * Validation of `.sighttrace` contents (ARCHITECTURE §7.14). A trace file is untrusted input: every
 * field of the parsed JSON is checked and copied into a fresh object, reading only own properties,
 * so nothing from the file is spread or merged and keys such as `__proto__` stay inert.
 */
import type { EditValue, TimedEdit, WriteTarget } from './api-types'
import {
  MAX_TRACE_EDITS,
  MAX_TRACE_PAYLOAD_BYTES,
  MAX_TRACE_SOURCE_LENGTH,
  MAX_TRACE_STEPS,
  TRACE_FORMAT,
  TRACE_FORMAT_VERSION,
  type TraceBundle,
  type TraceOutcome,
} from './trace-format'
import {
  checkpointStride,
  FINGERPRINT_PREFIX,
  MAX_CHECKPOINTS,
  type TraceCheckpoints,
} from './trace-hash'

const MAX_TITLE_LENGTH = 200
const MAX_VERSION_LENGTH = 64
const MAX_TEXT_LENGTH = 100_000

type Fields = { readonly [key: string]: unknown }

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An own property (never one inherited through a prototype). */
function own(fields: Fields, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined
}

class Invalid extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Invalid(message)
}

function integer(value: unknown, name: string, min: number, max: number): number {
  check(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be an integer from ${min} to ${max}`,
  )
  return value
}

function text(value: unknown, name: string, maxLength: number): string {
  check(typeof value === 'string' && value.length <= maxLength, `${name} must be a string`)
  return value
}

function object(value: unknown, name: string): Fields {
  check(isFields(value), `${name} must be an object`)
  return value
}

function list(value: unknown, name: string, maxLength: number): readonly unknown[] {
  check(Array.isArray(value) && value.length <= maxLength, `${name} must be a list`)
  return value
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID_MAX = 2 ** 31 - 1

function target(value: unknown, name: string): WriteTarget {
  const fields = object(value, name)
  const kind = own(fields, 'kind')
  switch (kind) {
    case 'local':
      return {
        kind,
        frameUid: integer(own(fields, 'frameUid'), `${name}.frameUid`, 1, ID_MAX),
        slot: integer(own(fields, 'slot'), `${name}.slot`, 0, ID_MAX),
      }
    case 'global': {
      const global = text(own(fields, 'name'), `${name}.name`, MAX_TITLE_LENGTH)
      check(NAME.test(global), `${name}.name must be a variable name`)
      return { kind, name: global }
    }
    case 'field':
      return {
        kind,
        objectId: integer(own(fields, 'objectId'), `${name}.objectId`, 1, ID_MAX),
        key: text(own(fields, 'key'), `${name}.key`, MAX_TEXT_LENGTH),
      }
    case 'element':
      return {
        kind,
        objectId: integer(own(fields, 'objectId'), `${name}.objectId`, 1, ID_MAX),
        index: integer(own(fields, 'index'), `${name}.index`, 0, ID_MAX),
      }
    case 'cell':
      return { kind, cellId: integer(own(fields, 'cellId'), `${name}.cellId`, 1, ID_MAX) }
    default:
      throw new Invalid(`${name}.kind must be local, global, field, element or cell`)
  }
}

const SPECIAL_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['-0', -0],
])

function editValue(value: unknown, name: string): EditValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return text(value, name, MAX_TEXT_LENGTH)
  const special = SPECIAL_NUMBERS.get(String(own(object(value, name), 'number')))
  check(special !== undefined, `${name} must be nil, a bool, a number or a string`)
  return special
}

function edits(value: unknown): TimedEdit[] {
  const items = list(value, 'edits', MAX_TRACE_EDITS)
  let previous = 0
  return items.map((item, index) => {
    const name = `edits[${index}]`
    const fields = object(item, name)
    const time = integer(own(fields, 'time'), `${name}.time`, previous, MAX_TRACE_STEPS - 1)
    previous = time
    const edit = object(own(fields, 'edit'), `${name}.edit`)
    return {
      time,
      edit: {
        target: target(own(edit, 'target'), `${name}.edit.target`),
        value: editValue(own(edit, 'value'), `${name}.edit.value`),
      },
    }
  })
}

function outcome(value: unknown, length: number): TraceOutcome {
  const fields = object(value, 'outcome')
  const kind = own(fields, 'kind')
  switch (kind) {
    case 'finished':
    case 'aborted':
      return { kind }
    case 'error': {
      const code = text(own(fields, 'code'), 'outcome.code', 4)
      check(/^R\d{3}$/.test(code), 'outcome.code must be a runtime error code')
      return {
        kind,
        code,
        message: text(own(fields, 'message'), 'outcome.message', MAX_TEXT_LENGTH),
        line: integer(own(fields, 'line'), 'outcome.line', 1, MAX_TRACE_SOURCE_LENGTH + 1),
      }
    }
    case 'step-limit':
      return {
        kind,
        maxSteps: integer(own(fields, 'maxSteps'), 'outcome.maxSteps', length, length),
      }
    default:
      throw new Invalid('outcome.kind must be finished, error, step-limit or aborted')
  }
}

function checkpoints(value: unknown, length: number): TraceCheckpoints {
  const fields = object(value, 'checkpoints')
  const stride = integer(own(fields, 'stride'), 'checkpoints.stride', 1, MAX_TRACE_STEPS)
  check(stride === checkpointStride(length), 'checkpoints.stride does not match the length')
  const hashes = list(own(fields, 'hashes'), 'checkpoints.hashes', MAX_CHECKPOINTS + 1)
  check(hashes.length === Math.ceil(length / stride), 'checkpoints.hashes has the wrong length')
  return {
    stride,
    hashes: hashes.map((hash, index) => {
      const hex = text(hash, `checkpoints.hashes[${index}]`, 16)
      check(/^[0-9a-f]{16}$/.test(hex), `checkpoints.hashes[${index}] must be 16 hex digits`)
      return hex
    }),
  }
}

function forkLimit(value: unknown, chain: readonly TimedEdit[]): number | null {
  const last = chain.at(-1)
  if (last === undefined) {
    check(value === null, 'forkMaxSteps must be null without edits')
    return null
  }
  return integer(value, 'forkMaxSteps', last.time + 1, MAX_TRACE_STEPS)
}

function headerFields(fields: Fields): { hindsightVersion: string; title: string | null } {
  check(own(fields, 'format') === TRACE_FORMAT, `format must be '${TRACE_FORMAT}'`)
  check(own(fields, 'version') === TRACE_FORMAT_VERSION, `version must be ${TRACE_FORMAT_VERSION}`)
  const version = text(own(fields, 'hindsightVersion'), 'hindsightVersion', MAX_VERSION_LENGTH)
  check(/^[0-9A-Za-z.+-]+$/.test(version), 'hindsightVersion must be a version number')
  const title = own(fields, 'title')
  return {
    hindsightVersion: version,
    title: title === null ? null : text(title, 'title', MAX_TITLE_LENGTH),
  }
}

/** The bundle in `value` (parsed JSON), or a description of the first problem. */
export function validateBundle(value: unknown): TraceBundle | string {
  try {
    const fields = object(value, 'the trace')
    const { hindsightVersion, title } = headerFields(fields)
    const source = text(own(fields, 'source'), 'source', MAX_TRACE_SOURCE_LENGTH)
    const seed = integer(
      own(fields, 'seed'),
      'seed',
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )
    const maxSteps = integer(own(fields, 'maxSteps'), 'maxSteps', 1, MAX_TRACE_STEPS)
    const length = integer(own(fields, 'length'), 'length', 0, MAX_TRACE_STEPS)
    const chain = edits(own(fields, 'edits'))
    const forkMaxSteps = forkLimit(own(fields, 'forkMaxSteps'), chain)
    check(length <= (forkMaxSteps ?? maxSteps), 'length is above the step limit')
    check(chain.length === 0 || chain[0]!.time < maxSteps, 'edits[0].time is above the step limit')
    const output = list(own(fields, 'output'), 'output', length).map((line, index) =>
      text(line, `output[${index}]`, MAX_TRACE_PAYLOAD_BYTES),
    )
    const fingerprint = text(own(fields, 'fingerprint'), 'fingerprint', 64)
    check(
      fingerprint.startsWith(FINGERPRINT_PREFIX) &&
        /^[0-9a-f]{16}$/.test(fingerprint.slice(FINGERPRINT_PREFIX.length)),
      'fingerprint must be fnv1a64: and 16 hex digits',
    )
    return {
      format: TRACE_FORMAT,
      version: TRACE_FORMAT_VERSION,
      hindsightVersion,
      title,
      source,
      seed,
      maxSteps,
      edits: chain,
      forkMaxSteps,
      time: integer(own(fields, 'time'), 'time', 0, length),
      outcome: outcome(own(fields, 'outcome'), length),
      length,
      output,
      fingerprint,
      checkpoints: checkpoints(own(fields, 'checkpoints'), length),
    }
  } catch (error) {
    if (error instanceof Invalid) return error.message
    throw error
  }
}
