import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  NODE_FILE_SYSTEM,
  saveTarget,
  temporaryPathFor,
  writeFileAtomically,
  type SaveFileSystem,
} from './atomic-write'

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'hindsight-atomic-'))
}

function failure(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

/** The real file system, with some calls replaced. */
function filesWith(overrides: Partial<SaveFileSystem>): SaveFileSystem {
  return { ...NODE_FILE_SYSTEM, ...overrides }
}

describe('writeFileAtomically', () => {
  test('writes a new file, and leaves nothing else beside it', async () => {
    // Arrange
    const dir = folder()
    const path = join(dir, 'new.sight')

    // Act
    await writeFileAtomically(path, 'print("Zoë")\n', process.platform)

    // Assert
    expect(readFileSync(path, 'utf8')).toBe('print("Zoë")\n')
    expect(readdirSync(dir)).toEqual(['new.sight'])
  })

  test('replaces all of an existing file', async () => {
    const dir = folder()
    const path = join(dir, 'old.sight')
    writeFileSync(path, 'a much longer program than the new one\n')

    await writeFileAtomically(path, 'short\n', process.platform)

    expect(readFileSync(path, 'utf8')).toBe('short\n')
    expect(readdirSync(dir)).toEqual(['old.sight'])
  })

  test('a disk that fills up mid-write leaves the file as it was, and no temporary file', async () => {
    // Arrange: the new text is half written when the disk is full.
    const dir = folder()
    const path = join(dir, 'kept.sight')
    writeFileSync(path, 'print("kept")\n')
    const files = filesWith({
      async create(temporary, text) {
        await writeFile(temporary, text.slice(0, text.length / 2), { flag: 'wx' })
        throw failure('ENOSPC')
      },
    })

    // Act
    const saving = writeFileAtomically(path, 'print("lost")\n'.repeat(100), 'linux', files)

    // Assert
    await expect(saving).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(readFileSync(path, 'utf8')).toBe('print("kept")\n')
    expect(readdirSync(dir)).toEqual(['kept.sight'])
  })

  test('a rename that fails leaves the file as it was, and no temporary file', async () => {
    const dir = folder()
    const path = join(dir, 'kept.sight')
    writeFileSync(path, 'print("kept")\n')
    const files = filesWith({
      rename: async () => {
        throw failure('EIO')
      },
    })

    await expect(writeFileAtomically(path, 'x', 'darwin', files)).rejects.toMatchObject({
      code: 'EIO',
    })
    expect(readFileSync(path, 'utf8')).toBe('print("kept")\n')
    expect(readdirSync(dir)).toEqual(['kept.sight'])
  })

  test('a folder that does not exist fails as before, with nothing written', async () => {
    const path = join(folder(), 'gone', 'lost.sight')

    await expect(writeFileAtomically(path, 'x', process.platform)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('the replaced file keeps its permissions on macOS and Linux', async () => {
    // Arrange: a file only its owner and group may read.
    const dir = folder()
    const path = join(dir, 'private.sight')
    writeFileSync(path, 'old')
    const modes: number[] = []
    const files = filesWith({
      stat: async () => ({ mode: 0o100640 }),
      chmod: async (target, mode) => {
        modes.push(mode)
        await NODE_FILE_SYSTEM.chmod(target, mode)
      },
    })

    // Act
    await writeFileAtomically(path, 'new', 'linux', files)
    await writeFileAtomically(path, 'newer', 'win32', files)

    // Assert: Windows has no such permissions to copy.
    expect(modes).toEqual([0o640])
    expect(readFileSync(path, 'utf8')).toBe('newer')
  })

  test.skipIf(process.platform === 'win32')('keeps the mode of a real file', async () => {
    const path = join(folder(), 'script.sight')
    writeFileSync(path, 'old')
    chmodSync(path, 0o751)

    await writeFileAtomically(path, 'new', process.platform)

    expect(statSync(path).mode & 0o7777).toBe(0o751)
  })

  test('a new file gets the default permissions', async () => {
    const modes: number[] = []
    const path = join(folder(), 'fresh.sight')

    await writeFileAtomically(
      path,
      'x',
      'linux',
      filesWith({ chmod: async (_, m) => void modes.push(m) }),
    )

    expect(modes).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('x')
  })

  test('on Windows a rename blocked for a moment is tried again', async () => {
    // Arrange: a scanner holds the new file for the first two attempts.
    const path = join(folder(), 'scanned.sight')
    let attempts = 0
    const files = filesWith({
      async rename(from, to) {
        attempts++
        if (attempts <= 2) throw failure('EPERM')
        await NODE_FILE_SYSTEM.rename(from, to)
      },
    })

    // Act
    await writeFileAtomically(path, 'x', 'win32', files)

    // Assert
    expect(attempts).toBe(3)
    expect(readFileSync(path, 'utf8')).toBe('x')
  })

  test('elsewhere, and for other errors, a failed rename is final', async () => {
    let attempts = 0
    const files = filesWith({
      rename: async () => {
        attempts++
        throw failure('EPERM')
      },
    })

    await expect(writeFileAtomically(join(folder(), 'a'), 'x', 'linux', files)).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  test('on Windows a rename that stays blocked fails in the end', async () => {
    let attempts = 0
    const dir = folder()
    const files = filesWith({
      rename: async () => {
        attempts++
        throw failure('EBUSY')
      },
    })

    await expect(writeFileAtomically(join(dir, 'a'), 'x', 'win32', files)).rejects.toMatchObject({
      code: 'EBUSY',
    })
    expect(attempts).toBe(5)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('where a save writes', () => {
  test('beside the file, under a new hidden name', () => {
    const target = resolve('code', 'fib.sight')

    expect(temporaryPathFor(target, 'abc123')).toBe(resolve('code', '.hindsight-abc123.tmp'))
  })

  test('through a symbolic link, to the file it points to', async () => {
    // Arrange
    const real = resolve('real', 'fib.sight')
    const files = filesWith({ realpath: async () => real })

    // Act and assert
    expect(await saveTarget(resolve('link.sight'), files)).toBe(real)
  })

  test('through a link to a file not made yet, to where it points', async () => {
    const link = resolve('code', 'link.sight')
    const files = filesWith({
      realpath: async () => {
        throw failure('ENOENT')
      },
      lstat: async () => ({ isSymbolicLink: () => true }),
      readlink: async () => '../elsewhere/fib.sight',
    })

    expect(await saveTarget(link, files)).toBe(resolve('elsewhere', 'fib.sight'))
  })

  test('a new file is written where asked', async () => {
    const path = join(folder(), 'new.sight')

    expect(await saveTarget(path, NODE_FILE_SYSTEM)).toBe(path)
  })

  test('other errors finding the file are reported', async () => {
    const looped = filesWith({
      realpath: async () => {
        throw failure('ELOOP')
      },
    })
    const denied = filesWith({
      realpath: async () => {
        throw failure('ENOENT')
      },
      lstat: async () => {
        throw failure('EACCES')
      },
    })

    await expect(saveTarget('/a', looped)).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(saveTarget('/a', denied)).rejects.toMatchObject({ code: 'EACCES' })
  })

  test('a real symbolic link keeps pointing to the saved file', async (context) => {
    // Arrange: Windows lets only administrators and developer mode make links.
    const dir = folder()
    const real = join(dir, 'real.sight')
    const link = join(dir, 'link.sight')
    writeFileSync(real, 'old')
    try {
      symlinkSync(real, link)
    } catch {
      context.skip()
    }

    // Act
    await writeFileAtomically(link, 'new', process.platform)

    // Assert
    expect(readFileSync(real, 'utf8')).toBe('new')
    expect(readFileSync(link, 'utf8')).toBe('new')
    expect(readdirSync(dir).sort()).toEqual(['link.sight', 'real.sight'])
    expect(dirname(real)).toBe(dir)
  })
})
