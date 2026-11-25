/**
 * Saving a file so that it is never left half-written: the text goes to a new file beside it, which
 * then takes its place in one rename. A full disk or an I/O error while writing leaves the user's
 * file as it was. Symbolic links are followed, so the file a link points to is replaced (not the
 * link), and a replaced file keeps its permissions.
 *
 * The file-system calls come in as a parameter, so the tests can make any step fail.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** The calls a save makes. */
export interface SaveFileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  readlink(path: string): Promise<string>
  stat(path: string): Promise<{ readonly mode: number }>
  /** Creates `path`, which must not exist yet, with `text`, and flushes it to the disk. */
  create(path: string, text: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

export const NODE_FILE_SYSTEM: SaveFileSystem = {
  realpath: (path) => fs.realpath(path),
  lstat: (path) => fs.lstat(path),
  readlink: (path) => fs.readlink(path),
  stat: (path) => fs.stat(path),
  async create(path, text) {
    const file = await fs.open(path, 'wx')
    try {
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
  },
  chmod: (path, mode) => fs.chmod(path, mode),
  rename: (from, to) => fs.rename(from, to),
  remove: (path) => fs.rm(path, { force: true }),
}

/** The permission bits a replaced file keeps (with setuid, setgid and sticky). */
const PERMISSION_BITS = 0o7777

/**
 * On Windows a rename fails while another program (often a virus scanner looking at the new file)
 * holds either file open; it is tried again after these pauses (ms).
 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 60, 150, 300]

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

/** The temporary file a save of `target` writes first: hidden, beside it, and new. */
export function temporaryPathFor(target: string, random: string): string {
  return join(dirname(target), `.hindsight-${random}.tmp`)
}

/**
 * The file a save of `path` replaces: where its symbolic links lead (even to a file that does not
 * exist yet), or `path` itself.
 */
export async function saveTarget(path: string, files: SaveFileSystem): Promise<string> {
  try {
    return await files.realpath(path)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
  try {
    if ((await files.lstat(path)).isSymbolicLink())
      return resolve(dirname(path), await files.readlink(path))
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
  return path
}

async function modeOf(path: string, files: SaveFileSystem): Promise<number | null> {
  try {
    return (await files.stat(path)).mode & PERMISSION_BITS
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null
    throw error
  }
}

const RETRIED_RENAME_ERRORS: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameOver(
  from: string,
  to: string,
  platform: string,
  files: SaveFileSystem,
): Promise<void> {
  const delays = platform === 'win32' ? RENAME_RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt++) {
    try {
      return await files.rename(from, to)
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !RETRIED_RENAME_ERRORS.has(codeOf(error))) throw error
      await new Promise((settle) => setTimeout(settle, delay))
    }
  }
}

/**
 * Writes `text` to `path` (UTF-8) atomically. On failure the error is thrown, the temporary file is
 * gone, and the file at `path` is untouched. `platform` is a process.platform: Windows keeps no
 * Unix permissions to copy, and its renames are retried.
 */
export async function writeFileAtomically(
  path: string,
  text: string,
  platform: string,
  files: SaveFileSystem = NODE_FILE_SYSTEM,
): Promise<void> {
  const target = await saveTarget(path, files)
  const mode = platform === 'win32' ? null : await modeOf(target, files)
  const temporary = temporaryPathFor(target, randomBytes(8).toString('hex'))
  try {
    await files.create(temporary, text)
    if (mode !== null) await files.chmod(temporary, mode)
    await renameOver(temporary, target, platform, files)
  } catch (error) {
    await files.remove(temporary).catch(() => undefined)
    throw error
  }
}
