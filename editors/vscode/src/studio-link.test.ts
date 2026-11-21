import { describe, expect, test } from 'vitest'
import { MAX_SHARED_SOURCE_LENGTH, momentFromFragment } from '../../../src/studio/lib/share'
import { DEFAULT_STUDIO_URL, studioLink } from './studio-link'

describe('studio links', () => {
  test('carry the program and the step in the fragment the studio reads', () => {
    // Arrange
    const source = 'let name = "Zoë"\nprint("hi {name}")\n'

    // Act
    const link = studioLink(source, 12)

    // Assert
    if (!link.ok) throw new Error(link.error)
    expect(link.url.startsWith(`${DEFAULT_STUDIO_URL}/#src=`)).toBe(true)
    expect(link.url.endsWith('&t=12')).toBe(true)
    const fragment = link.url.slice(link.url.indexOf('#'))
    expect(momentFromFragment(fragment)).toEqual({ source, time: 12 })
  })

  test('leave the step out when there is no moment', () => {
    const link = studioLink('print(1)\n', null)

    if (!link.ok) throw new Error(link.error)
    expect(link.url).not.toContain('&t=')
  })

  test('refuse programs over the link limit and point to trace files', () => {
    const link = studioLink('x'.repeat(MAX_SHARED_SOURCE_LENGTH + 1), 0)

    expect(link.ok).toBe(false)
    if (link.ok) return
    expect(link.error).toContain('60,000 characters')
    expect(link.error).toContain('hindsight record')
  })

  test('accept a configured studio with a path, dropping any fragment it had', () => {
    const link = studioLink('print(1)\n', 3, ' http://localhost:5173/studio/#old ')

    if (!link.ok) throw new Error(link.error)
    expect(link.url).toMatch(/^http:\/\/localhost:5173\/studio\/#src=[A-Za-z0-9_-]+&t=3$/)
  })

  test('add the root path to a bare origin', () => {
    const link = studioLink('print(1)\n', 3, 'https://example.test')

    if (!link.ok) throw new Error(link.error)
    expect(link.url.startsWith('https://example.test/#src=')).toBe(true)
  })

  test('reject a studio setting that is not an http(s) URL', () => {
    for (const base of ['javascript:alert(1)', 'file:///etc/passwd', 'example.test', '']) {
      const link = studioLink('print(1)\n', 0, base)

      expect(link).toEqual({ ok: false, error: 'hindsight.studioUrl must be an http(s) URL.' })
    }
  })
})
