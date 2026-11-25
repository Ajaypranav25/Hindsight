import { describe, expect, test, vi } from 'vitest'
import { encodeSource, MAX_SHARED_SOURCE_LENGTH } from '../lib/share'
import {
  APP_LINK_BASE,
  appLink,
  DESKTOP_BRIDGE_KEY,
  desktopBridge,
  fragmentOfAppLink,
  MAX_APP_LINK_LENGTH,
} from './bridge'

function fakeBridge() {
  return {
    platform: 'win32',
    version: '0.0.0',
    onOpen: vi.fn(() => () => {}),
    onCommand: vi.fn(() => () => {}),
    saveProgram: vi.fn(),
    setDocument: vi.fn(),
    ready: vi.fn(),
  }
}

describe('desktopBridge', () => {
  test('finds the bridge the preload script defines', () => {
    // Arrange
    const bridge = fakeBridge()

    // Act
    const found = desktopBridge({ [DESKTOP_BRIDGE_KEY]: bridge })

    // Assert
    expect(found).toBe(bridge)
  })

  test('is null in a browser, and for anything that is not a whole bridge', () => {
    expect(desktopBridge({})).toBeNull()
    expect(desktopBridge({ [DESKTOP_BRIDGE_KEY]: null })).toBeNull()
    expect(desktopBridge({ [DESKTOP_BRIDGE_KEY]: 'bridge' })).toBeNull()
    const { ready: _ready, ...partial } = fakeBridge()
    expect(desktopBridge({ [DESKTOP_BRIDGE_KEY]: partial })).toBeNull()
  })
})

describe('hindsight:// links', () => {
  test('a program link round-trips through the app link parser', () => {
    // Arrange
    const source = 'let x = 1\nprint(x + 1)\n'

    // Act
    const link = appLink(source, 12)
    const fragment = fragmentOfAppLink(link!)

    // Assert
    expect(link).toBe(`${APP_LINK_BASE}/#src=${encodeSource(source)}&t=12`)
    expect(fragment).toBe(`#src=${encodeSource(source)}&t=12`)
  })

  test('a link without a moment has no t parameter', () => {
    expect(appLink('print(1)', null)).toBe(`${APP_LINK_BASE}/#src=${encodeSource('print(1)')}`)
  })

  test('the bare form without a slash is accepted too', () => {
    const fragment = `#src=${encodeSource('print(1)')}`
    expect(fragmentOfAppLink(`hindsight://open${fragment}`)).toBe(fragment)
  })

  test('programs too long for a command line get no link', () => {
    // Arrange: within the studio's share limit, but past the app-link limit.
    const source = 'x'.repeat(Math.ceil((MAX_APP_LINK_LENGTH * 3) / 4))

    // Act
    const link = appLink(source, null)

    // Assert
    expect(source.length).toBeLessThan(MAX_SHARED_SOURCE_LENGTH)
    expect(link).toBeNull()
    expect(appLink('x'.repeat(MAX_SHARED_SOURCE_LENGTH + 1), null)).toBeNull()
  })

  test('the longest program that fits still opens', () => {
    // Arrange: the largest size that still gets a link (binary search).
    let size = 1
    let tooLong = MAX_APP_LINK_LENGTH
    while (tooLong - size > 1) {
      const middle = Math.floor((size + tooLong) / 2)
      if (appLink('x'.repeat(middle), 99) === null) tooLong = middle
      else size = middle
    }

    // Act
    const link = appLink('x'.repeat(size), 99)

    // Assert
    expect(link!.length).toBeLessThanOrEqual(MAX_APP_LINK_LENGTH)
    expect(fragmentOfAppLink(link!)).not.toBeNull()
  })

  test('rejects anything that is not a hindsight://open link carrying a program', () => {
    const fragment = `#src=${encodeSource('print(1)')}`
    for (const url of [
      `https://open/${fragment}`,
      `hindsight://other/${fragment}`,
      `hindsight://open/path${fragment}`,
      `hindsight://open/?file=/etc/passwd${fragment}`,
      `hindsight://user:pass@open/${fragment}`,
      `hindsight://open:8080/${fragment}`,
      'hindsight://open/',
      'hindsight://open/#src=%%%',
      'hindsight://open/#other=1',
      'not a url',
      '',
      `hindsight://open/#src=${'A'.repeat(MAX_APP_LINK_LENGTH)}`,
    ]) {
      expect(fragmentOfAppLink(url), url).toBeNull()
    }
  })
})
