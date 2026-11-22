import { afterEach, describe, expect, test, vi } from 'vitest'
import { copyText, selectText } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  test('resolves true when the clipboard takes the text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  test('resolves false without a clipboard, when it refuses, or when it throws at once', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyText('a')).resolves.toBe(false)
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('no')) } })
    await expect(copyText('b')).resolves.toBe(false)
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: () => {
          throw new Error('not allowed')
        },
      },
    })
    await expect(copyText('c')).resolves.toBe(false)
  })
})

describe('selectText', () => {
  test('does nothing where there is no selection to make', () => {
    vi.stubGlobal('getSelection', () => null)
    expect(() => selectText({} as Node)).not.toThrow()
  })

  test('selects the children of the node', () => {
    const selectAllChildren = vi.fn()
    vi.stubGlobal('getSelection', () => ({ selectAllChildren }))
    const node = {} as Node
    selectText(node)
    expect(selectAllChildren).toHaveBeenCalledWith(node)
  })
})
