import type { DragEvent } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { droppedTraceFile, traceDropHandlers } from './trace-drop'

function dragEvent(files: readonly File[], types: readonly string[] = ['Files']) {
  const event = {
    dataTransfer: { files, types },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
  return event as typeof event & DragEvent<HTMLElement>
}

const trace = new File([new Uint8Array([7, 8, 9])], 'run.sighttrace')
const text = new File(['print(1)\n'], 'notes.txt')

describe('dropping files on the editor', () => {
  test('finds the first trace file among the dropped files', () => {
    expect(droppedTraceFile({ files: [text, trace] as unknown as FileList })).toBe(trace)
    expect(droppedTraceFile({ files: [text] as unknown as FileList })).toBeNull()
    expect(droppedTraceFile(null)).toBeNull()
  })

  test('accepts a file drag so the browser does not open the file itself', () => {
    // Arrange
    const handlers = traceDropHandlers(vi.fn())
    const files = dragEvent([trace])
    const words = dragEvent([], ['text/plain'])

    // Act
    handlers.onDragOverCapture(files)
    handlers.onDragOverCapture(words)

    // Assert
    expect(files.preventDefault).toHaveBeenCalledOnce()
    expect(words.preventDefault).not.toHaveBeenCalled()
  })

  test('opens a dropped trace file instead of inserting it as text', async () => {
    // Arrange
    const open = vi.fn().mockResolvedValue(undefined)
    const event = dragEvent([text, trace])

    // Act
    traceDropHandlers(open).onDropCapture(event)

    // Assert
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(new Uint8Array([7, 8, 9])))
  })

  test('leaves other drops to the editor', () => {
    // Arrange
    const open = vi.fn()
    const event = dragEvent([text])

    // Act
    traceDropHandlers(open).onDropCapture(event)

    // Assert
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})
