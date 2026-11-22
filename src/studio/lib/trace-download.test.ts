import { describe, expect, test, vi } from 'vitest'
import type { Recording } from '../../core/api-types'
import { compile, decodeTraceFile, record } from '../../core/index'
import {
  isTraceFileName,
  programTitle,
  saveFile,
  STUDIO_VERSION,
  traceDownload,
  traceFileName,
  type DownloadHost,
} from './trace-download'

function recordSource(source: string): Recording {
  const compiled = compile(source)
  if (!compiled.ok) throw new Error('does not compile')
  return record(compiled.program)
}

describe('trace file names', () => {
  test('read the program title from its header comment', () => {
    expect(programTitle('// title: Linked list  \nprint(1)\n')).toBe('Linked list')
    expect(programTitle('// summary: no title\nprint(1)\n')).toBeNull()
  })

  test('turn a title into a lowercase dashed file name', () => {
    expect(traceFileName('Hello, Hindsight')).toBe('hello-hindsight.sighttrace')
    expect(traceFileName('Café  au_lait!')).toBe('cafe-au-lait.sighttrace')
  })

  test('fall back to "program" for a missing or symbol-only title', () => {
    expect(traceFileName(null)).toBe('program.sighttrace')
    expect(traceFileName('???')).toBe('program.sighttrace')
  })

  test('cap long titles without leaving a trailing dash', () => {
    const name = traceFileName(`${'a'.repeat(59)} b`)
    expect(name).toBe(`${'a'.repeat(59)}.sighttrace`)
  })

  test('recognize trace files by extension, ignoring case', () => {
    expect(isTraceFileName('run.SightTrace')).toBe(true)
    expect(isTraceFileName('run.sight')).toBe(false)
  })
})

describe('traceDownload', () => {
  test('encodes the run on display with its title, pen and the studio version', async () => {
    // Arrange
    const recording = recordSource('// title: Two lines\nprint(1)\nprint(2)\n')

    // Act
    const result = await traceDownload({ recording, base: null, time: 3 })

    // Assert
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.name).toBe('two-lines.sighttrace')
    const decoded = await decodeTraceFile(result.bytes)
    expect(decoded.ok && decoded.bundle).toMatchObject({
      title: 'Two lines',
      time: 3,
      hindsightVersion: STUDIO_VERSION,
      output: ['1', '2'],
    })
  })

  test('explains a run that cannot be saved', async () => {
    // Arrange
    const recording = recordSource('print(1)\n')
    const huge = { ...recording, program: { ...recording.program, source: 'x'.repeat(200_001) } }

    // Act
    const result = await traceDownload({ recording: huge, base: null, time: 0 })

    // Assert
    expect(result).toEqual({ ok: false, error: 'the program is too long to save as a trace' })
  })
})

describe('saveFile', () => {
  test('clicks a temporary download link and revokes its URL afterwards', () => {
    // Arrange
    const click = vi.fn()
    const remove = vi.fn()
    const link = { click, remove } as unknown as HTMLAnchorElement
    const append = vi.fn()
    const timers: Array<() => void> = []
    const host: DownloadHost = {
      document: {
        createElement: (() => link) as Document['createElement'],
        body: { append } as unknown as HTMLElement,
      },
      createObjectURL: vi.fn(() => 'blob:trace'),
      revokeObjectURL: vi.fn(),
      setTimeout: (callback) => timers.push(callback),
    }

    // Act
    saveFile(new Uint8Array([1, 2, 3]), 'run.sighttrace', host)

    // Assert
    expect(link.href).toBe('blob:trace')
    expect(link.download).toBe('run.sighttrace')
    expect(append).toHaveBeenCalledWith(link)
    expect(click).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(host.revokeObjectURL).not.toHaveBeenCalled()
    timers.forEach((callback) => callback())
    expect(host.revokeObjectURL).toHaveBeenCalledWith('blob:trace')
  })
})
