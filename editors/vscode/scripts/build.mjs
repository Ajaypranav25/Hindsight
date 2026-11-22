// Bundles the extension, with the Hindsight core it imports from the repository's src/core, into
// one CommonJS file: dist/extension.js. Only `vscode` (provided by the editor) and Node built-ins may
// stay external; the build fails if anything else would be required at run time.
//
//   node scripts/build.mjs            a readable bundle with a source map (development)
//   node scripts/build.mjs --minify   what `vsce package` ships
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const OUTFILE = 'dist/extension.js'
const minify = process.argv.includes('--minify')

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/glue/extension.ts'],
  outfile: OUTFILE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.90 runs extensions on Node 20.
  target: 'node20',
  external: ['vscode'],
  minify,
  sourcemap: !minify,
  metafile: true,
  logLevel: 'info',
})

const builtins = new Set(builtinModules)
const allowed = (path) =>
  path === 'vscode' || path.startsWith('node:') || builtins.has(path.split('/')[0])
const unbundled = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !allowed(entry.path))
  .map((entry) => entry.path)

if (unbundled.length > 0) {
  console.error(`${OUTFILE} would require packages at run time: ${[...new Set(unbundled)]}`)
  process.exit(1)
}
