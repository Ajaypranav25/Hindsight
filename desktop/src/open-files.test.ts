import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { MAX_TRACE_FILE_BYTES } from '../../src/core/trace-format'
import { MAX_PROGRAM_BYTES } from './messages'
import {
  describeFileError,
  fileKindOf,
  OPEN_FILTERS,
  openRequestFor,
  pathKey,
  SAVE_FILTERS,
  sizeLimitOf,
  sizeProblem,
} from './open-files'

const PROGRAM = resolve('code', 'fib.sight')
const TRACE = resolve('code', 'run.sighttrace')

describe('kinds of file', () => {
  test('.sighttrace files are traces and everything else is a program', () => {
    expect(fileKindOf(TRACE)).toBe('trace')
    expect(fileKindOf(resolve('RUN.SIGHTTRACE'))).toBe('trace')
    expect(fileKindOf(PROGRAM)).toBe('program')
    expect(fileKindOf(resolve('notes.txt'))).toBe('program')
  })

  test('each kind has its own size limit', () => {
    expect(sizeLimitOf('program')).toBe(MAX_PROGRAM_BYTES)
    expect(sizeLimitOf('trace')).toBe(MAX_TRACE_FILE_BYTES)
    expect(sizeProblem(PROGRAM, MAX_PROGRAM_BYTES)).toBeNull()
    expect(sizeProblem(PROGRAM, MAX_PROGRAM_BYTES + 1)).toBe(
      'fib.sight is too large to open. Programs can be at most 5 MB.',
    )
    expect(sizeProblem(TRACE, MAX_TRACE_FILE_BYTES + 1)).toBe(
      'run.sighttrace is too large to open. Traces can be at most 32 MB.',
    )
  })
})

describe('openRequestFor', () => {
  test('a program is decoded as UTF-8, without a byte order mark', () => {
    // Arrange
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('print("Zoë")\n')])

    // Act
    const result = openRequestFor(PROGRAM, bytes)

    // Assert
    expect(result).toEqual({
      ok: true,
      request: { kind: 'program', source: 'print("Zoë")\n', path: PROGRAM, name: 'fib.sight' },
    })
  })

  test('a program that is not UTF-8 is refused rather than garbled', () => {
    const result = openRequestFor(PROGRAM, new Uint8Array([0x70, 0xff, 0xfe, 0x41]))

    expect(result).toEqual({
      ok: false,
      message: 'fib.sight is not a Hindsight program: it is not UTF-8 text.',
    })
  })

  test('a trace is passed on as bytes for the studio to check', () => {
    const bytes = new TextEncoder().encode('SIGHTTRC')

    expect(openRequestFor(TRACE, bytes)).toEqual({
      ok: true,
      request: { kind: 'trace', bytes, name: 'run.sighttrace' },
    })
  })

  test('files over the limit are refused', () => {
    const result = openRequestFor(PROGRAM, new Uint8Array(MAX_PROGRAM_BYTES + 1))

    expect(result.ok).toBe(false)
  })
})

describe('pathKey', () => {
  test('ignores case where the file system does', () => {
    expect(pathKey(resolve('Code', 'Fib.sight'), 'win32')).toBe(
      pathKey(resolve('code', 'fib.sight'), 'win32'),
    )
    expect(pathKey(resolve('Code', 'Fib.sight'), 'darwin')).toBe(
      pathKey(resolve('code', 'fib.sight'), 'darwin'),
    )
    expect(pathKey(resolve('Code', 'Fib.sight'), 'linux')).not.toBe(
      pathKey(resolve('code', 'fib.sight'), 'linux'),
    )
  })

  test('normalizes the path', () => {
    expect(pathKey(resolve('code', '..', 'fib.sight'), 'linux')).toBe(resolve('fib.sight'))
  })
})

describe('dialogs and errors', () => {
  test('Open offers programs, traces and all files; Save writes programs', () => {
    expect(OPEN_FILTERS.map((filter) => filter.extensions)).toEqual([
      ['sight', 'sighttrace'],
      ['sight'],
      ['sighttrace'],
      ['*'],
    ])
    expect(SAVE_FILTERS).toEqual([{ name: 'Hindsight programs', extensions: ['sight'] }])
  })

  test('file errors read as plain reasons', () => {
    const error = (code: string) => Object.assign(new Error(`${code}: raw`), { code })

    expect(describeFileError(error('ENOENT'))).toBe('it does not exist')
    expect(describeFileError(error('EACCES'))).toBe('permission was denied')
    expect(describeFileError(error('EBUSY'))).toBe('it is in use by another program')
    expect(describeFileError(error('EWEIRD'))).toBe('EWEIRD: raw')
    expect(describeFileError(new Error(''))).toBe('of an unknown error')
    expect(describeFileError('boom')).toBe('of an unknown error')
    expect(describeFileError(null)).toBe('of an unknown error')
  })
})
