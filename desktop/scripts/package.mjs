// Packages the built app (dist/) with electron-builder, for the system this runs on:
//
//   node scripts/package.mjs          the installers (`npm run dist`)
//   node scripts/package.mjs --dir    only the unpacked app, for the e2e tests (`npm run pack`)
//
// Both build every architecture electron-builder.cjs lists for this system (on macOS: Intel and
// Apple Silicon, in release/mac and release/mac-arm64). The unpacked app keeps Electron's --inspect
// switch working, because Playwright drives the app through it; the installers ship with it off.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'electron-builder'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = createRequire(import.meta.url)('../electron-builder.cjs')
const dir = process.argv.includes('--dir')

const testable = {
  ...config,
  electronFuses: { ...config.electronFuses, enableNodeCliInspectArguments: true },
}

/** The architectures the configuration builds on this system. */
function configuredArchs() {
  const platform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]
  const targets = config[platform]?.target ?? []
  return new Set(targets.flatMap((target) => target.arch ?? []))
}

try {
  const archs = configuredArchs()
  const artifacts = await build({
    projectDir: desktop,
    config: dir ? testable : config,
    publish: 'never',
    // Without these, an unpacked build is made only for the architecture of this machine.
    ...(dir ? { dir, x64: archs.has('x64'), arm64: archs.has('arm64') } : {}),
  })
  for (const artifact of artifacts) console.log(`Built ${artifact}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
