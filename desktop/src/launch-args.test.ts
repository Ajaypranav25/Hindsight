import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { appLink } from '../../src/studio/desktop/bridge'
import {
  appFolderArg,
  instanceData,
  launchTargets,
  MAX_LAUNCH_TARGETS,
  parseInstanceData,
  type LaunchContext,
} from './launch-args'

const CWD = resolve('work')
const LINK = appLink('print("linked")\n', 7)!
const FRAGMENT = LINK.slice(LINK.indexOf('#'))

function packaged(...args: string[]): LaunchContext {
  return { argv: ['/opt/Hindsight/hindsight', ...args], cwd: CWD, defaultApp: false }
}

describe('launchTargets', () => {
  test('a packaged app opens the files it was given, resolved against its folder', () => {
    // Arrange
    const absolute = resolve('elsewhere', 'b.sight')

    // Act
    const targets = launchTargets(packaged('a.sight', absolute))

    // Assert
    expect(targets).toEqual([
      { kind: 'file', path: resolve(CWD, 'a.sight') },
      { kind: 'file', path: absolute },
    ])
  })

  test('development runs skip the app folder Electron was given', () => {
    // Arrange: `electron . fib.sight`, and Playwright's own switches before the folder.
    const context: LaunchContext = {
      argv: ['electron', '--inspect=0', '--remote-debugging-port=0', '.', 'fib.sight'],
      cwd: CWD,
      defaultApp: true,
    }

    // Act
    const targets = launchTargets(context)

    // Assert
    expect(targets).toEqual([{ kind: 'file', path: resolve(CWD, 'fib.sight') }])
  })

  test('switches are skipped until --, after which everything is an argument', () => {
    const targets = launchTargets(
      packaged('--no-sandbox', '-psn_0_12345', 'a.sight', '--', '--odd-name.sight'),
    )

    expect(targets).toEqual([
      { kind: 'file', path: resolve(CWD, 'a.sight') },
      { kind: 'file', path: resolve(CWD, '--odd-name.sight') },
    ])
  })

  test('hindsight:// program links become link targets; other links are dropped', () => {
    const targets = launchTargets(
      packaged(LINK, 'hindsight://open/#src=%%%', 'hindsight://elsewhere/', 'https://example.com'),
    )

    expect(targets).toEqual([{ kind: 'link', fragment: FRAGMENT }])
  })

  test('file: URLs from Linux desktop entries become paths', () => {
    // Arrange
    const path = resolve('programs', 'fib demo.sight')

    // Act: the second URL hides a separator in an escape, which no file path can hold.
    const targets = launchTargets(packaged(pathToFileURL(path).href, 'file:///a%2Fb.sight'))

    // Assert
    expect(targets).toEqual([{ kind: 'file', path }])
  })

  test('a Windows drive path is a path, not a URL', () => {
    const targets = launchTargets(packaged('C:\\code\\fib.sight'))

    expect(targets).toHaveLength(1)
    expect(targets[0]?.kind).toBe('file')
  })

  test('repeats, blanks and too many targets are dropped', () => {
    const many = Array.from({ length: MAX_LAUNCH_TARGETS + 5 }, (_, index) => `f${index}.sight`)

    expect(launchTargets(packaged('a.sight', 'a.sight', LINK, LINK, '  '))).toHaveLength(2)
    expect(launchTargets(packaged(...many))).toHaveLength(MAX_LAUNCH_TARGETS)
  })

  test('nothing to open when there are no arguments', () => {
    expect(launchTargets(packaged())).toEqual([])
    expect(launchTargets({ argv: ['electron', '.'], cwd: CWD, defaultApp: true })).toEqual([])
  })
})

describe('second launches', () => {
  test('pass their command line and folder to the running app', () => {
    // Arrange
    const context = packaged('fib.sight')

    // Act
    const data = parseInstanceData(JSON.parse(JSON.stringify(instanceData(context))))

    // Assert
    expect(data).toEqual(context)
    expect(launchTargets(data!)).toEqual([{ kind: 'file', path: resolve(CWD, 'fib.sight') }])
  })

  test('malformed data is ignored', () => {
    for (const data of [
      null,
      'argv',
      { argv: 'x', cwd: CWD, defaultApp: false },
      { argv: [1], cwd: CWD, defaultApp: false },
      { argv: [], cwd: 1, defaultApp: false },
      { argv: [], cwd: CWD },
      { argv: Array.from({ length: 1001 }, () => 'x'), cwd: CWD, defaultApp: false },
    ])
      expect(parseInstanceData(data)).toBeNull()
  })
})

describe('appFolderArg', () => {
  test('is the first argument that is not a switch', () => {
    expect(appFolderArg(['electron', '--inspect', '.', 'a.sight'])).toBe('.')
    expect(appFolderArg(['electron', '--inspect'])).toBeNull()
  })
})
