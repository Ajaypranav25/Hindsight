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
  color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
}
