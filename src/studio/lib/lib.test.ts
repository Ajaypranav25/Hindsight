import { describe, expect, test } from 'vitest'
import {
  clipText,
  DISPLAY_TEXT_LIMIT,
  formatCount,
  formatSteps,
  formatValue,
  reprString,
  sameValue,
  tapeDigits,
  truncate,
} from './format'
import {
  decodeSource,
  encodeSource,
  MAX_SHARED_SOURCE_LENGTH,
  shareFragment,
  sourceFromFragment,
  takeSharedSource,
  watchSharedLinks,
  type ShareHost,
} from './share'
import { browserStorage, memoryStorage, readJson, writeJson } from './storage'

describe('format', () => {
  test('groups counts with commas', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(0)).toBe('0')
  })

  test('formats compact step counts for axis labels', () => {
    expect(formatSteps(950)).toBe('950')
    expect(formatSteps(1500)).toBe('1.5k')
    expect(formatSteps(56_789)).toBe('57k')
    expect(formatSteps(2_000_000)).toBe('2M')
    expect(formatSteps(1_250_000)).toBe('1.3M')
    expect(formatSteps(12_000_000)).toBe('12M')
  })

  test('pads tape digits into groups of three', () => {
    expect(tapeDigits(1234, 7)).toBe('0 001 234')
    expect(tapeDigits(0, 3)).toBe('000')
    expect(tapeDigits(56_789_012, 7)).toBe('56 789 012')
    expect(tapeDigits(-5, 4)).toBe('0 000')
  })

  test('reprString escapes like SPEC §4.3', () => {
    expect(reprString('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(reprString('line\nnext\ttab\r')).toBe('"line\\nnext\\ttab\\r"')
    expect(reprString('\u0001')).toBe('"\\u{1}"')
    expect(reprString('{braces}')).toBe('"{braces}"')
  })

  test('formats value views', () => {
    expect(formatValue({ kind: 'nil' })).toBe('nil')
    expect(formatValue({ kind: 'bool', value: false })).toBe('false')
    expect(formatValue({ kind: 'number', value: 0.5 })).toBe('0.5')
    expect(formatValue({ kind: 'string', value: 'hi' })).toBe('"hi"')
    expect(formatValue({ kind: 'ref', id: 3, type: 'list', preview: '[1, 2]' })).toBe('[1, 2]')
  })

  test('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })

  test('compares values for change highlighting', () => {
    expect(sameValue({ kind: 'number', value: NaN }, { kind: 'number', value: NaN })).toBe(true)
    expect(sameValue({ kind: 'number', value: 1 }, { kind: 'string', value: '1' })).toBe(false)
    const ref = { kind: 'ref', id: 1, type: 'list', preview: '[1]' } as const
    expect(sameValue(ref, { ...ref, preview: '[1, 2]' })).toBe(false)
    expect(sameValue({ kind: 'nil' }, { kind: 'nil' })).toBe(true)
  })
})

describe('display limits', () => {
  test('clipText keeps short text and cuts long text with a count of the rest', () => {
    expect(clipText('short')).toBe('short')
    expect(clipText('abcdef', 4)).toBe('abcd… (2 more characters)')
    expect(clipText('abcde', 4)).toBe('abcd… (1 more character)')
    expect(clipText('ab\u{1F680}', 3)).toBe('ab… (2 more characters)')
  })

  test('formatValue cuts long strings before quoting them', () => {
    const text = formatValue({ kind: 'string', value: 'y'.repeat(DISPLAY_TEXT_LIMIT + 5) })
    expect(text).toBe(`"${'y'.repeat(DISPLAY_TEXT_LIMIT)}"… (5 more characters)`)
  })
})

describe('share links', () => {
  test('round-trips unicode source through base64url', () => {
    const source = 'print("héllo {name} ✓ 🚀")\n// done'
    const encoded = encodeSource(source)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeSource(encoded)).toBe(source)
  })

  test('rejects malformed payloads', () => {
    expect(decodeSource('not base64!')).toBeNull()
    expect(decodeSource('_w')).toBeNull() // 0xff is not valid UTF-8
  })

  test('builds and reads fragments', () => {
    const fragment = shareFragment('print(1)')
    expect(fragment).toMatch(/^#src=/)
    expect(sourceFromFragment(fragment ?? '')).toBe('print(1)')
    expect(sourceFromFragment('#other')).toBeNull()
    expect(sourceFromFragment('src=' + encodeSource('x'))).toBe('x')
  })

  test('refuses programs too large for a link', () => {
    expect(shareFragment('x'.repeat(MAX_SHARED_SOURCE_LENGTH + 1))).toBeNull()
  })

  function fakeHost(hash: string) {
    const listeners = new Set<() => void>()
    const urls: (string | undefined)[] = []
    const location = { hash, pathname: '/studio/', search: '?x=1' }
    const host: ShareHost & { location: typeof location } = {
      location,
      history: {
        replaceState: (_data, _unused, url) => {
          urls.push(url)
          location.hash = ''
        },
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    }
    const fire = () => listeners.forEach((listener) => listener())
    return { host, urls, listeners, fire }
  }

  test('uses a share link once: the fragment is removed after reading it', () => {
    const { host, urls } = fakeHost(shareFragment('print(1)')!)
    expect(takeSharedSource(host)).toBe('print(1)')
    expect(urls).toEqual(['/studio/?x=1'])
    expect(takeSharedSource(host)).toBeNull()
  })

  test('leaves other fragments alone and tolerates hosts without history or location', () => {
    const { host, urls } = fakeHost('#section')
    expect(takeSharedSource(host)).toBeNull()
    expect(urls).toEqual([])
    expect(takeSharedSource({})).toBeNull()
    expect(
      takeSharedSource({ location: { hash: shareFragment('x')!, pathname: '/', search: '' } }),
    ).toBe('x')
  })

  test('loads a share link pasted while the studio is open', () => {
    const { host, urls, listeners, fire } = fakeHost('')
    const loaded: string[] = []
    const stop = watchSharedLinks(host, (source) => loaded.push(source))
    fire()
    host.location.hash = shareFragment('print(2)')!
    fire()
    expect(loaded).toEqual(['print(2)'])
    expect(urls).toHaveLength(1)
    stop()
    expect(listeners.size).toBe(0)
  })
})

describe('storage', () => {
  test('memory storage reads back writes', () => {
    const storage = memoryStorage({ a: '1' })
    storage.write('b', '2')
    expect(storage.read('a')).toBe('1')
    expect(storage.read('b')).toBe('2')
    expect(storage.read('c')).toBeNull()
    storage.remove('a')
    expect(storage.read('a')).toBeNull()
  })

  test('readJson validates and tolerates garbage', () => {
    const storage = memoryStorage({ good: '{"n":1}', bad: '{nope', wrong: '"text"' })
    const isN = (v: unknown): v is { n: number } =>
      typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number'
    expect(readJson(storage, 'good', isN)).toEqual({ n: 1 })
    expect(readJson(storage, 'bad', isN)).toBeNull()
    expect(readJson(storage, 'wrong', isN)).toBeNull()
    expect(readJson(storage, 'missing', isN)).toBeNull()
    writeJson(storage, 'w', { n: 2 })
    expect(readJson(storage, 'w', isN)).toEqual({ n: 2 })
  })

  test('browser storage degrades to a no-op without localStorage', () => {
    const storage = browserStorage()
    expect(() => storage.write('k', 'v')).not.toThrow()
    expect(storage.read('k') === null || storage.read('k') === 'v').toBe(true)
  })
})
