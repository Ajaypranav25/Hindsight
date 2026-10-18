// Bundles the command-line tool into a single ESM file: dist/cli/hindsight.mjs
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli/hindsight.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true,
  logLevel: 'info',
})
