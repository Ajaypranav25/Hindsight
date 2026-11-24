// Packages the built app (dist/) with electron-builder, for the system this runs on:
//
//   node scripts/package.mjs          the installers (`npm run dist`)
//   node scripts/package.mjs --dir    only the unpacked app, for the e2e tests (`npm run pack`)
//
// The unpacked app keeps Electron's --inspect switch working, because Playwright drives the app
// through it; the installers ship with it switched off (electron-builder.cjs, electronFuses).
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

try {
  const artifacts = await build({
    projectDir: desktop,
    config: dir ? testable : config,
    dir,
    publish: 'never',
  })
  for (const artifact of artifacts) console.log(`Built ${artifact}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
