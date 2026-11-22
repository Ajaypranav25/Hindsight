// Bundles the command-line tool into a single ESM file: dist/cli/hindsight.mjs
//
// The published package (hindsight-lang) ships only this file and has no runtime dependencies, so
// the build fails if anything but a Node built-in is left for the bundle to import at run time.
import { builtinModules } from 'node:module'
import { build } from 'esbuild'

const OUTFILE = 'dist/cli/hindsight.mjs'

const result = await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  metafile: true,
  logLevel: 'info',
})

const builtins = new Set(builtinModules)
const isBuiltin = (path) => path.startsWith('node:') || builtins.has(path.split('/')[0])
const unbundled = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !isBuiltin(entry.path))
  .map((entry) => entry.path)

if (unbundled.length > 0) {
  console.error(
    `${OUTFILE} would import packages at run time: ${[...new Set(unbundled)].join(', ')}`,
  )
  process.exit(1)
}
