import { describe, expect, test } from 'vitest'
import {
  encodeSource,
  momentFromFragment,
  shareFragment,
  sourceFromFragment,
  takeSharedMoment,
  takeSharedSource,
  watchSharedLinks,
  type ShareHost,
} from './share'

function host(hash: string, replaced: string[]): ShareHost {
  return {
    location: { hash, pathname: '/studio', search: '?x=1' },
    history: { replaceState: (_data, _unused, url) => replaced.push(url ?? '') },
  }
}

describe('moment links', () => {
  test('carry the pen step after the program', () => {
    const fragment = shareFragment('print(1)', 3500)!
    expect(fragment).toMatch(/^#src=[A-Za-z0-9_-]+&t=3500$/)
    expect(momentFromFragment(fragment)).toEqual({ source: 'print(1)', time: 3500 })
    expect(sourceFromFragment(fragment)).toBe('print(1)')
    expect(shareFragment('x', 12.7)).toBe(`#src=${encodeSource('x')}&t=12`)
  })

  test('a plain link has no moment; a malformed step is ignored', () => {
    expect(momentFromFragment(shareFragment('x')!)).toEqual({ source: 'x', time: null })
    expect(momentFromFragment(shareFragment('x', null)!)).toEqual({ source: 'x', time: null })
    expect(momentFromFragment(`#src=${encodeSource('x')}&t=-4`)).toEqual({
      source: 'x',
      time: null,
    })
    expect(momentFromFragment(`src=${encodeSource('x')}&q=1&t=9`)).toEqual({ source: 'x', time: 9 })
    expect(momentFromFragment('#elsewhere')).toBeNull()
    expect(momentFromFragment('#src=%%&t=1')).toBeNull()
  })

  test('are read once: the fragment is removed', () => {
    const replaced: string[] = []
    expect(takeSharedMoment(host(shareFragment('p', 7)!, replaced))).toEqual({
      source: 'p',
      time: 7,
    })
    expect(takeSharedSource(host(shareFragment('q', 8)!, replaced))).toBe('q')
    expect(replaced).toEqual(['/studio?x=1', '/studio?x=1'])
    expect(takeSharedMoment(host('', replaced))).toBeNull()
  })

  test('a pasted moment link reaches the studio with its step', () => {
    let listener = () => {}
    const loads: [string, number | null][] = []
    const stop = watchSharedLinks(
      {
        ...host(shareFragment('p', 42)!, []),
        addEventListener: (_type, l) => (listener = l),
        removeEventListener: () => {},
      },
      (source, time) => loads.push([source, time]),
    )
    listener()
    stop()
    expect(loads).toEqual([['p', 42]])
  })
})
