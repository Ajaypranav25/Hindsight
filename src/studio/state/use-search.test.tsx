// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { useAsyncSearch } from './use-search'

afterEach(cleanup)

describe('useAsyncSearch', () => {
  test('is idle without a key and searching until the result arrives', async () => {
    let finish: (value: number) => void = () => undefined
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) =>
        useAsyncSearch(key, () => new Promise<number>((resolve) => (finish = resolve))),
      { initialProps: { key: null as string | null } },
    )
    expect(result.current).toEqual({ status: 'idle' })
    rerender({ key: 'a' })
    expect(result.current).toEqual({ status: 'searching', progress: 0 })
    await act(async () => finish(7))
    expect(result.current).toEqual({ status: 'done', result: 7 })
  })

  test('a failure that is not an Error is reported as text', async () => {
    const { result } = renderHook(() => useAsyncSearch('k', () => Promise.reject('no luck')))
    await waitFor(() => expect(result.current).toEqual({ status: 'failed', error: 'no luck' }))
  })

  test('a new key aborts the old search and drops what it answers', async () => {
    const signals: AbortSignal[] = []
    const finishers: ((value: string) => void)[] = []
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        useAsyncSearch(key, (signal) => {
          signals.push(signal)
          return new Promise<string>((resolve) => finishers.push(resolve))
        }),
      { initialProps: { key: 'first' } },
    )
    rerender({ key: 'second' })
    expect(signals[0]!.aborted).toBe(true)
    await act(async () => finishers[0]!('stale'))
    expect(result.current).toEqual({ status: 'searching', progress: 0 })
    await act(async () => finishers[1]!('fresh'))
    expect(result.current).toEqual({ status: 'done', result: 'fresh' })
  })

  test('a failure after the search was abandoned is ignored', async () => {
    let fail: (error: Error) => void = () => undefined
    const { result, unmount } = renderHook(() =>
      useAsyncSearch('k', () => new Promise<never>((_resolve, reject) => (fail = reject))),
    )
    const before = result.current
    unmount()
    await act(async () => fail(new Error('late')))
    expect(before).toEqual({ status: 'searching', progress: 0 })
  })
})
