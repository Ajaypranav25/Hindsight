/**
 * The desktop app's declarative files kept in step with the code, the language package and the
 * download site: the version, the app's identity, and the installer names the site links to.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import { APP_LINK_SCHEME } from '../../src/studio/desktop/bridge'
import { TRACE_FILE_EXTENSION } from '../../src/core/trace-format'
import { APP_ID, APP_NAME } from './identity'

type Json = Record<string, unknown>

function readJson(relative: string): Json {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as Json
}

const desktop = readJson('../package.json')
const root = readJson('../../package.json')
const builder = createRequire(import.meta.url)('../electron-builder.cjs') as Json

function section(name: string): Json {
  return builder[name] as Json
}

/** The width and height of a PNG in the desktop folder, from its header. */
function pngSize(relative: string): readonly [number, number] {
  const bytes = readFileSync(new URL(`../${relative}`, import.meta.url))
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

describe('the desktop package', () => {
  // Fails until the repository's package.json is bumped to the app's version (0.5.0).
  test('has the same version as the hindsight-lang package', () => {
    expect(desktop.version).toBe(root.version)
  })

  test('is private, MIT, and names its author by a no-reply address', () => {
    expect(desktop.private).toBe(true)
    expect(desktop.license).toBe('MIT')
    expect(desktop.productName).toBe(APP_NAME)
    expect(desktop.main).toBe('dist/main.js')
    expect(desktop.author).toEqual({
      name: 'Ajaypranav25',
      email: 'ajaypranav25@users.noreply.github.com',
    })
  })

  test('pins Electron and electron-builder exactly', () => {
    const dependencies = desktop.devDependencies as Record<string, string>

    expect(dependencies.electron).toBe('45.4.1')
    expect(dependencies['electron-builder']).toBe('26.18.0')
  })
})

describe('the installers', () => {
  test('carry the app identity the main process uses', () => {
    expect(builder.appId).toBe(APP_ID)
    expect(builder.productName).toBe(APP_NAME)
  })

  test('have the exact, version-less names the download site links to', () => {
    expect(section('nsis').artifactName).toBe('Hindsight-Setup-x64.exe')
    expect(section('mac').artifactName).toBe('Hindsight-mac-${arch}.${ext}')
    expect(section('dmg').artifactName).toBe('Hindsight-mac-${arch}.${ext}')
    expect(section('appImage').artifactName).toBe('Hindsight-linux-x86_64.AppImage')
    expect(section('deb').artifactName).toBe('Hindsight-linux-amd64.deb')
  })

  test('build both Mac architectures, signed ad hoc', () => {
    const targets = section('mac').target as { target: string; arch: string[] }[]

    expect(targets.map((target) => target.target).sort()).toEqual(['dmg', 'zip'])
    for (const target of targets) expect([...target.arch].sort()).toEqual(['arm64', 'x64'])
    expect(section('mac').identity).toBe('-')
    expect(section('mac').hardenedRuntime).toBe(false)
  })

  test('leave the `hindsight` command to the language on Linux', () => {
    const cli = Object.keys(root.bin as Record<string, string>)

    expect(cli).toContain('hindsight')
    expect(cli).not.toContain(section('linux').executableName)
  })

  test('open .sight and .sighttrace files and hindsight:// links', () => {
    const associations = builder.fileAssociations as { ext: string; role: string }[]
    const protocols = builder.protocols as { schemes: string[] }[]

    expect(associations.map((association) => `.${association.ext}`)).toEqual([
      '.sight',
      TRACE_FILE_EXTENSION,
    ])
    expect(associations.map((association) => association.role)).toEqual(['Editor', 'Viewer'])
    expect(protocols.flatMap((protocol) => protocol.schemes)).toEqual([APP_LINK_SCHEME])
  })

  test('name the Linux launcher entry as Electron names the window', () => {
    // Electron takes app_id / WM_CLASS and the xdg-settings handler name from desktopName.
    expect(desktop.desktopName).toBe(`${String(section('linux').executableName)}.desktop`)
    expect(section('linux').syncDesktopName).toBe(true)
  })

  test('give Linux a full icon set, and Windows and macOS the large icon', () => {
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512]

    expect(builder.icon).toBe('build/icon.png')
    expect(pngSize('build/icon.png')).toEqual([1024, 1024])
    expect(section('linux').icon).toBe('build/icons')
    expect(readdirSync(new URL('../build/icons', import.meta.url)).sort()).toEqual(
      sizes.map((size) => `${size}x${size}.png`).sort(),
    )
    for (const size of sizes)
      expect(pngSize(`build/icons/${size}x${size}.png`)).toEqual([size, size])
  })

  test('ship with the fuses that let code run through the app switched off', () => {
    expect(builder.electronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
    })
  })
})
