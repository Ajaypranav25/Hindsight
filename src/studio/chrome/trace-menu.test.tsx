// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  compareRecordings,
  compile,
  encodeTraceFileSync,
  record,
  recordAsync,
  traceBundle,
} from '../../core/index'
import { memoryStorage } from '../lib/storage'
import { StudioProvider } from '../state/context'
import { ManualScheduler } from '../state/scheduler'
import { createStudioStore } from '../state/store'
import type { Engine } from '../state/types'
import { Share } from './Share'

const PROGRAM = '// title: Two prints\nprint(1)\nprint(2)\n'

function setup(source = PROGRAM) {
  const engine: Engine = { compile, recordAsync, compare: compareRecordings }
  const store = createStudioStore(
    { engine, storage: memoryStorage(), scheduler: new ManualScheduler(), examples: [] },
    { sharedSource: source },
  )
  render(
    <StudioProvider store={store}>
      <Share />
    </StudioProvider>,
  )
  return { store }
}

function traceFileFor(source: string, time: number): File {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  const bundle = traceBundle({
    recording: record(compiled.program),
    time,
    hindsightVersion: '0.3.0',
    title: null,
  })
  if (!bundle.ok) throw new Error(bundle.error)
  const encoded = encodeTraceFileSync(bundle.bundle)
  if (!encoded.ok) throw new Error(encoded.error)
  return new File([encoded.bytes as Uint8Array<ArrayBuffer>], 'saved.sighttrace')
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Trace files' }))

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:x'),
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the trace files menu', () => {
  test('offers no download before there is a run', () => {
    // Arrange
    setup()

    // Act
    openMenu()

    // Assert
    const download = screen.getByRole('menuitem', { name: /Download trace/ })
    expect((download as HTMLButtonElement).disabled).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Open trace/ }))
  })

  test('downloads the run as a file named after the program', async () => {
    // Arrange
    const { store } = setup()
    await act(() => store.getState().run())
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    openMenu()

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Download trace/ }))
    })

    // Assert
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce())
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('two-prints.sighttrace')
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
  })

  test('explains a run that cannot be saved as a trace', async () => {
    // Arrange
    const { store } = setup()
    await act(() => store.getState().run())
    const recording = store.getState().recording!
    const program = { ...recording.program, source: 'x'.repeat(200_001) }
    act(() => store.setState({ recording: { ...recording, program } }))
    openMenu()

    // Act
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Download trace/ }))
    })

    // Assert
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This run cannot be saved as a trace: the program is too long to save as a trace.',
    )
  })

  test('opens a chosen trace file and lands on its saved step', async () => {
    // Arrange
    const { store } = setup('print("mine")\n')
    const input = screen.getByTestId('trace-file-input') as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {})
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Open trace/ }))
    expect(inputClick).toHaveBeenCalledOnce()

    // Act
    await act(async () => {
      fireEvent.change(input, { target: { files: [traceFileFor(PROGRAM, 2)] } })
    })

    // Assert
    await vi.waitFor(() => expect(store.getState().recordedSource).toBe(PROGRAM))
    expect(store.getState().time).toBe(2)
  })

  test('arrow keys move between the enabled items and Tab closes the menu', async () => {
    // Arrange
    const { store } = setup()
    await act(() => store.getState().run())
    openMenu()
    const menu = screen.getByRole('menu', { name: 'Trace files' })
    const [download, open] = screen.getAllByRole('menuitem')

    // Act and assert
    expect(document.activeElement).toBe(download)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(open)
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(download)
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(open)
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(download)
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(open)
    fireEvent.keyDown(menu, { key: 'x' })
    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
