import { describe, expect, test } from 'vitest'
import { encodeSource } from '../../src/studio/lib/share'
import {
  CHANNELS,
  isAbsolutePath,
  isFileName,
  MAX_NAME_LENGTH,
  MAX_PROGRAM_BYTES,
  parseCommand,
  parseDocumentState,
  parseOpenRequest,
  parseSaveRequest,
  parseSaveResult,
  platformOf,
  utf8Length,
  versionFromArgv,
  versionSwitch,
} from './messages'

const PATH = '/home/ada/fib.sight'
const WINDOWS_PATH = 'C:\\Users\\Ada\\fib.sight'

describe('channels', () => {
  test('are distinct and namespaced', () => {
    const names = Object.values(CHANNELS)

    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^hindsight:[a-z-]+$/)
  })
})

describe('paths and names', () => {
  test('absolute paths of all three systems are accepted', () => {
    expect(isAbsolutePath(PATH)).toBe(true)
    expect(isAbsolutePath(WINDOWS_PATH)).toBe(true)
    expect(isAbsolutePath('D:/code/fib.sight')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\fib.sight')).toBe(true)
  })

  test('relative and drive-relative paths are not', () => {
    for (const path of ['fib.sight', './fib.sight', '..\\fib.sight', 'C:fib.sight', '\\\\', ''])
      expect(isAbsolutePath(path), path).toBe(false)
  })

  test('file names have no folders or control characters', () => {
    expect(isFileName('fib.sight')).toBe(true)
    expect(isFileName('Zoë – notes.sight')).toBe(true)
    for (const name of ['', 'a/b.sight', 'a\\b.sight', 'a\nb', 'a\u0000b', 'x'.repeat(256), 3])
      expect(isFileName(name), String(name)).toBe(false)
    expect(isFileName('x'.repeat(MAX_NAME_LENGTH))).toBe(true)
  })

  test('UTF-8 length counts multi-byte characters', () => {
    expect(utf8Length('abc')).toBe(3)
    const wide = '€'.repeat(MAX_PROGRAM_BYTES / 2)
    expect(utf8Length(wide)).toBe(wide.length * 3)
  })
})

describe('save requests from the page', () => {
  test('a request to a file or to a new file is accepted as a fresh object', () => {
    // Arrange
    const payload = { source: 'print(1)\n', path: PATH }

    // Act
    const request = parseSaveRequest(payload)

    // Assert
    expect(request).toEqual(payload)
    expect(request).not.toBe(payload)
    expect(parseSaveRequest({ source: '', path: null })).toEqual({ source: '', path: null })
  })

  test('anything else is refused', () => {
    for (const payload of [
      null,
      'print(1)',
      [],
      { source: 1, path: null },
      { source: 'x', path: 'relative.sight' },
      { source: 'x', path: '' },
      { source: 'x', path: `${PATH}\u0000.txt` },
      { source: 'x', path: '/'.repeat(40_000) },
      { source: 'x' },
      { source: 'x'.repeat(MAX_PROGRAM_BYTES + 1), path: null },
      { source: '€'.repeat(MAX_PROGRAM_BYTES / 3 + 1), path: null },
      new (class {
        source = 'x'
        path = null
      })(),
    ])
      expect(parseSaveRequest(payload), JSON.stringify(payload)?.slice(0, 80)).toBeNull()
  })
})

describe('document state from the page', () => {
  test('a named or unnamed document is accepted', () => {
    expect(parseDocumentState({ name: 'fib.sight', dirty: true })).toEqual({
      name: 'fib.sight',
      dirty: true,
    })
    expect(parseDocumentState({ name: null, dirty: false })).toEqual({ name: null, dirty: false })
  })

  test('a name with folders, or a missing flag, is refused', () => {
    for (const payload of [
      { name: '../../etc/passwd', dirty: false },
      { name: 'fib.sight' },
      { name: 'fib.sight', dirty: 'yes' },
      { name: 7, dirty: false },
      undefined,
    ])
      expect(parseDocumentState(payload)).toBeNull()
  })
})

describe('messages to the page', () => {
  test('commands are the contract’s four', () => {
    for (const command of ['save', 'save-as', 'new', 'save-and-close'])
      expect(parseCommand(command)).toBe(command)
    expect(parseCommand('quit')).toBeNull()
    expect(parseCommand(1)).toBeNull()
  })

  test('open requests of each kind pass through checked', () => {
    // Arrange
    const fragment = `#src=${encodeSource('print(1)\n')}&t=4`
    const bytes = new Uint8Array([83, 73, 71, 72, 84])

    // Act and assert
    expect(
      parseOpenRequest({ kind: 'program', source: 'print(1)', path: PATH, name: 'fib.sight' }),
    ).toEqual({ kind: 'program', source: 'print(1)', path: PATH, name: 'fib.sight' })
    expect(parseOpenRequest({ kind: 'trace', bytes, name: 'run.sighttrace' })).toEqual({
      kind: 'trace',
      bytes,
      name: 'run.sighttrace',
    })
    expect(parseOpenRequest({ kind: 'link', fragment })).toEqual({ kind: 'link', fragment })
  })

  test('malformed open requests never reach the studio', () => {
    for (const payload of [
      { kind: 'program', source: 'x', path: 'fib.sight', name: 'fib.sight' },
      { kind: 'program', source: 'x', path: PATH, name: 'a/b' },
      { kind: 'program', source: null, path: PATH, name: 'fib.sight' },
      { kind: 'trace', bytes: [1, 2, 3], name: 'run.sighttrace' },
      { kind: 'trace', bytes: new Uint8Array(1), name: '' },
      { kind: 'link', fragment: '#src=%%%' },
      { kind: 'link', fragment: '#other=1' },
      { kind: 'link', fragment: 7 },
      { kind: 'file', path: PATH },
      null,
    ])
      expect(parseOpenRequest(payload)).toBeNull()
  })

  test('save results are checked, and anything unexpected reads as a failed save', () => {
    expect(parseSaveResult({ ok: true, path: PATH, name: 'fib.sight' })).toEqual({
      ok: true,
      path: PATH,
      name: 'fib.sight',
    })
    expect(parseSaveResult({ ok: false, reason: 'cancelled' })).toEqual({
      ok: false,
      reason: 'cancelled',
    })
    expect(parseSaveResult({ ok: false, reason: 'failed', message: 'disk full' })).toEqual({
      ok: false,
      reason: 'failed',
      message: 'disk full',
    })
    for (const reply of [
      undefined,
      { ok: true, path: 'fib.sight', name: 'fib.sight' },
      { ok: false, reason: 'failed' },
      { ok: false, reason: 'other' },
      { ok: 'yes' },
    ])
      expect(parseSaveResult(reply)).toMatchObject({ ok: false, reason: 'failed' })
  })
})

describe('app facts for the preload', () => {
  test('the version travels as a renderer switch', () => {
    const argv = ['electron', '--type=renderer', versionSwitch('0.5.0'), '--lang=en-US']

    expect(versionFromArgv(argv)).toBe('0.5.0')
    expect(versionFromArgv(['electron', versionSwitch('1.2.3-beta.1')])).toBe('1.2.3-beta.1')
  })

  test('a missing or odd version reads as 0.0.0', () => {
    expect(versionFromArgv(['electron'])).toBe('0.0.0')
    expect(versionFromArgv([versionSwitch('<script>')])).toBe('0.0.0')
  })

  test('platforms map onto the three the bridge knows', () => {
    expect(platformOf('win32')).toBe('win32')
    expect(platformOf('darwin')).toBe('darwin')
    expect(platformOf('linux')).toBe('linux')
    expect(platformOf('freebsd')).toBe('linux')
  })
})
