// Builds the studio as one self-contained page (dist/page/index.html) for publishing.
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import base from './vite.config'
import { inlinePage } from './src/build/page-inline'

function inlineIntoPage(): Plugin {
  return {
    name: 'hindsight-inline-page',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['index.html']
      if (!page || page.type !== 'asset') throw new Error('inline-page: index.html was not built')
      const read = (publicPath: string) => {
        const item = bundle[publicPath.replace(/^\.?\//, '')]
        if (!item) return undefined
        return item.type === 'chunk' ? item.code : String(item.source)
      }
      page.source = inlinePage(String(page.source), read)
      for (const name of Object.keys(bundle)) if (name !== 'index.html') delete bundle[name]
    },
  }
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [inlineIntoPage()],
    // The published page cannot receive #src= links, so "Copy link" copies the program instead.
    define: { 'import.meta.env.VITE_SHARE_MODE': JSON.stringify('source') },
    // The analysis worker travels inside the page (a blob URL) instead of as a file of its own.
    resolve: {
      alias: [
        {
          find: './analysis-worker-factory',
          replacement: fileURLToPath(
            new URL('./src/studio/analysis/analysis-worker-factory.inline.ts', import.meta.url),
          ),
        },
      ],
    },
    build: {
      outDir: 'dist/page',
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }),
)
