import { describe, expect, test } from 'vitest'
import { APP_ORIGIN, externalUrl, isAllowedPermission, isAppUrl, STUDIO_ENTRY_URL } from './origin'

describe('the studio origin', () => {
  test('covers every path of app://studio and nothing else', () => {
    expect(isAppUrl(STUDIO_ENTRY_URL)).toBe(true)
    expect(isAppUrl(`${APP_ORIGIN}/assets/index.js?v=1#top`)).toBe(true)
    expect(isAppUrl(APP_ORIGIN)).toBe(true)
    for (const url of [
      'app://other/index.html',
      'app://studio:8080/index.html',
      'app://user@studio/index.html',
      'https://studio/index.html',
      'file:///C:/index.html',
      'hindsight://open/#src=cHJpbnQoMSk',
      'not a url',
      '',
    ])
      expect(isAppUrl(url), url).toBe(false)
  })
})

describe('external links', () => {
  test('web pages and email addresses go to the system', () => {
    expect(externalUrl('https://github.com/Ajaypranav25/Hindsight')).toBe(
      'https://github.com/Ajaypranav25/Hindsight',
    )
    expect(externalUrl('http://example.com')).toBe('http://example.com/')
    expect(externalUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  test('nothing that could run or read something locally does', () => {
    for (const url of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'app://studio/index.html',
      'hindsight://open/#src=cHJpbnQoMSk',
      'ms-settings:privacy',
      'smb://server/share',
      'https://',
      'not a url',
    ])
      expect(externalUrl(url), url).toBeNull()
  })
})

describe('permissions', () => {
  test('the studio may only write to the clipboard', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', APP_ORIGIN)).toBe(true)
    expect(isAllowedPermission('clipboard-sanitized-write', STUDIO_ENTRY_URL)).toBe(true)
    for (const permission of [
      'clipboard-read',
      'media',
      'geolocation',
      'notifications',
      'openExternal',
    ])
      expect(isAllowedPermission(permission, APP_ORIGIN), permission).toBe(false)
  })

  test('no other origin gets even the clipboard', () => {
    expect(isAllowedPermission('clipboard-sanitized-write', 'https://example.com')).toBe(false)
    expect(isAllowedPermission('clipboard-sanitized-write', '')).toBe(false)
  })
})
