/**
 * What the app was asked to open on its command line: files (from Explorer, a file manager, a
 * terminal or a second launch) and `hindsight://` links (Windows and Linux hand links to the app as
 * an argument). macOS delivers both through events instead, so there the command line only matters
 * when the app is started from a terminal.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentOfAppLink } from '../../src/studio/desktop/bridge'

export type LaunchTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'link'; readonly fragment: string }

export interface LaunchContext {
  /** The process's whole argv, the executable first. */
  readonly argv: readonly string[]
  /** The directory relative paths are resolved against. */
  readonly cwd: string
  /**
   * True when Electron runs the app from its folder (`electron .`, `npm start`, tests): then the
   * first argument that is not a switch is that folder, not something to open.
   */
  readonly defaultApp: boolean
}

/** More than this many targets in one launch are ignored: each would replace the last anyway. */
export const MAX_LAUNCH_TARGETS = 20

/** A scheme of two letters or more, so `C:\file.sight` is a path and not a URL. */
const URL_PATTERN = /^[a-z][a-z0-9+.-]+:/i

function targetOf(arg: string, cwd: string): LaunchTarget | null {
  if (/^hindsight:/i.test(arg)) {
    const fragment = fragmentOfAppLink(arg)
    return fragment === null ? null : { kind: 'link', fragment }
  }
  if (/^file:/i.test(arg)) {
    try {
      return { kind: 'file', path: fileURLToPath(arg) }
    } catch {
      return null
    }
  }
  if (URL_PATTERN.test(arg) || arg.trim() === '' || arg.includes('\0')) return null
  return { kind: 'file', path: resolve(cwd, arg) }
}

function sameTarget(a: LaunchTarget, b: LaunchTarget): boolean {
  return a.kind === 'file' && b.kind === 'file'
    ? a.path === b.path
    : a.kind === 'link' && b.kind === 'link' && a.fragment === b.fragment
}

/**
 * The files and links in a launch's arguments, in order. Switches (`--inspect=0`, Chromium's own,
 * macOS's `-psn_…`) are skipped until a `--`, after which everything is an argument. Relative
 * paths are resolved against `cwd`; `file:` URLs (Linux desktop entries pass them) become paths;
 * links that are not valid `hindsight://open` program links are dropped.
 */
export function launchTargets({ argv, cwd, defaultApp }: LaunchContext): LaunchTarget[] {
  const targets: LaunchTarget[] = []
  let switches = true
  let skipAppFolder = defaultApp
  for (const arg of argv.slice(1)) {
    if (switches && arg === '--') {
      switches = false
      continue
    }
    if (switches && arg.startsWith('-')) continue
    if (skipAppFolder) {
      skipAppFolder = false
      continue
    }
    const target = targetOf(arg, cwd)
    if (target !== null && !targets.some((seen) => sameTarget(seen, target))) targets.push(target)
    if (targets.length === MAX_LAUNCH_TARGETS) break
  }
  return targets
}

/**
 * What a second launch passes to the running app (requestSingleInstanceLock's additional data):
 * its own argv and directory, which Electron otherwise reports with Chromium's switches mixed in.
 */
export function instanceData(context: LaunchContext): LaunchContext {
  return { argv: [...context.argv], cwd: context.cwd, defaultApp: context.defaultApp }
}

/** The additional data of a second launch, checked (another process wrote it), or null. */
export function parseInstanceData(value: unknown): LaunchContext | null {
  if (typeof value !== 'object' || value === null) return null
  const { argv, cwd, defaultApp } = value as Record<string, unknown>
  if (!Array.isArray(argv) || argv.length > 1_000) return null
  if (!argv.every((arg): arg is string => typeof arg === 'string')) return null
  if (typeof cwd !== 'string' || typeof defaultApp !== 'boolean') return null
  return { argv, cwd, defaultApp }
}

/**
 * The app folder Electron was started with in development (`electron .`): the first argument that
 * is not a switch. The `hindsight://` handler registered in development launches Electron with it.
 */
export function appFolderArg(argv: readonly string[]): string | null {
  return argv.slice(1).find((arg) => !arg.startsWith('-')) ?? null
}
