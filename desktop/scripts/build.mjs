// Builds the desktop app into dist/: the main process (dist/main.js), the preload script
// (dist/preload.js) and a copy of the built studio (dist/studio/, from the repository's
// dist/studio: run `npm run build:studio` at the repository root first).
//
// Both bundles are CommonJS with only `electron` left to require at run time. The preload runs in
// a sandbox, where `electron` is the only module require() can load, so the build fails if
// anything else (a Node built-in included) would be left for it to import.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(desktop, 'dist')
const studio = resolve(desktop, '..', 'dist', 'studio')

if (!existsSync(join(studio, 'index.html'))) {
  console.error(
    `The studio is not built (${studio} has no index.html).\n` +
      'Run `npm run build:studio` at the repository root first.',
  )
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
  absWorkingDir: desktop,
}

const [, preload] = await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' }),
])

const preloadImports = Object.values(preload.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && entry.path !== 'electron')
  .map((entry) => entry.path)
if (preloadImports.length > 0) {
  console.error(
    `dist/preload.js would require ${[...new Set(preloadImports)].join(', ')}, which a sandboxed ` +
      'preload cannot load. Keep the modules it imports free of Node built-ins.',
  )
  process.exit(1)
}

cpSync(studio, join(out, 'studio'), { recursive: true })
console.log(`Copied the studio from ${studio}`)
