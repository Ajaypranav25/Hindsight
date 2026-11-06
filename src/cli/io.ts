import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Everything the CLI touches outside itself, so commands can be tested with fakes. */
export interface CliIO {
  readFile(path: string): string
  /** Paths (relative to `dir`, forward slashes) of files under `dir` ending in `extension`. */
  listFiles(dir: string, extension: string): string[]
  stdout(text: string): void
  stderr(text: string): void
  readonly color: boolean
}

function walk(dir: string, extension: string, root: string, found: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, extension, root, found)
    else if (entry.endsWith(extension)) found.push(relative(root, path).split('\\').join('/'))
  }
}

export const nodeIO: CliIO = {
  readFile: (path) => readFileSync(path, 'utf8'),
  listFiles(dir, extension) {
    const found: string[] = []
    walk(dir, extension, dir, found)
    return found.sort()
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  // One style serves both streams, so color needs both to be terminals: `hindsight check x
  // 2> errors.log` must not write escape codes into the file.
  color: Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.NO_COLOR,
}

/** The part of a stream that reports write failures. */
export interface ErrorSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

/**
 * Ends the process quietly once the reader of `stream` has gone away (`hindsight run x | head`):
 * the rest of the output has nowhere to go, which is not an error. Other stream errors still throw.
 */
export function exitQuietlyOnClosedPipe(stream: ErrorSource, exit: (code: number) => void): void {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error
    exit(0)
  })
}
