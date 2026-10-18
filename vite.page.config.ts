// Builds the studio as one self-contained page (dist/page/index.html) for publishing.
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
    build: {
      outDir: 'dist/page',
      sourcemap: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  }),
)
