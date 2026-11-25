import { describe, expect, test } from 'vitest'
import { fragmentOfAppLink, MAX_APP_LINK_LENGTH } from '../../../src/studio/desktop/bridge'
import { MAX_SHARED_SOURCE_LENGTH, momentFromFragment } from '../../../src/studio/lib/share'
import { APP_LINK_BASE, studioLink, STUDIO_URL_ERROR } from './studio-link'

describe('links to the desktop app (the default)', () => {
  test('carry the program and the step in a hindsight:// link the app accepts', () => {
    // Arrange
    const source = 'let name = "Zoë"\nprint("hi {name}")\n'

    // Act
    const link = studioLink(source, 12)

    // Assert
    if (!link.ok) throw new Error(link.error)
    expect(APP_LINK_BASE).toBe('hindsight://open')
    expect(link.url.startsWith('hindsight://open/#src=')).toBe(true)
    expect(link.url.endsWith('&t=12')).toBe(true)
    const fragment = fragmentOfAppLink(link.url)
    expect(fragment).not.toBeNull()
    expect(momentFromFragment(fragment!)).toEqual({ source, time: 12 })
  })

  test('leave the step out when there is no moment', () => {
    const link = studioLink('print(1)\n', null)

    if (!link.ok) throw new Error(link.error)
    expect(link.url).not.toContain('&t=')
  })

  test('carry a CRLF file (VS Code on Windows) with the LF line breaks the studio keeps', () => {
    const crlf = studioLink('let x = 1\r\nprint(x)\r\n', 4)
    const lf = studioLink('let x = 1\nprint(x)\n', 4)

    expect(crlf).toEqual(lf)
  })

  test('accept the setting written with a slash, in any case, with spaces around it', () => {
    for (const base of ['hindsight://open/', ' HINDSIGHT://open ', 'hindsight://open#old']) {
      const link = studioLink('print(1)\n', 3, base)

      if (!link.ok) throw new Error(`${base}: ${link.error}`)
      expect(link.url).toMatch(/^hindsight:\/\/open\/#src=[A-Za-z0-9_-]+&t=3$/)
    }
  })

  test('refuse programs whose link would pass the app-link limit and point to File > Open', () => {
    // Arrange: short enough for a browser link, too long for one the app is handed.
    const source = 'x'.repeat(Math.ceil((MAX_APP_LINK_LENGTH * 3) / 4))

    // Act
    const link = studioLink(source, 0)

    // Assert
    expect(source.length).toBeLessThan(MAX_SHARED_SOURCE_LENGTH)
    expect(link.ok).toBe(false)
    if (link.ok) return
    expect(link.error).toContain('30,000 characters')
    expect(link.error).toContain('File > Open')
  })
})

describe('links to a studio served over http(s)', () => {
  test('carry the program in the fragment the studio reads, dropping any fragment it had', () => {
    const link = studioLink('print(1)\n', 3, ' http://localhost:5173/studio/#old ')

    if (!link.ok) throw new Error(link.error)
    expect(link.url).toMatch(/^http:\/\/localhost:5173\/studio\/#src=[A-Za-z0-9_-]+&t=3$/)
    const fragment = link.url.slice(link.url.indexOf('#'))
    expect(momentFromFragment(fragment)).toEqual({ source: 'print(1)\n', time: 3 })
  })

  test('add the root path to a bare origin', () => {
    const link = studioLink('print(1)\n', 3, 'https://example.test')

    if (!link.ok) throw new Error(link.error)
    expect(link.url.startsWith('https://example.test/#src=')).toBe(true)
  })

  test('hold programs up to the studio’s own limit and point past it to trace files', () => {
    const fits = studioLink('x'.repeat(MAX_APP_LINK_LENGTH), 0, 'http://localhost:5173')
    const tooLong = studioLink('x'.repeat(MAX_SHARED_SOURCE_LENGTH + 1), 0, 'http://localhost:5173')

    expect(fits.ok).toBe(true)
    expect(tooLong.ok).toBe(false)
    if (tooLong.ok) return
    expect(tooLong.error).toContain('60,000 characters')
    expect(tooLong.error).toContain('hindsight record')
  })
})

describe('the studio setting', () => {
  test('rejects anything but hindsight://open and http(s) URLs', () => {
    for (const base of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'example.test',
      'hindsight://other',
      'hindsight://open/path',
      'hindsight://open?x=1',
      '',
    ]) {
      const link = studioLink('print(1)\n', 0, base)

      expect(link, base).toEqual({ ok: false, error: STUDIO_URL_ERROR })
    }
  })
})
