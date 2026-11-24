import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built studio works from any path: the desktop app serves it from
  // its own protocol, and a static host may serve it below the site root.
  base: './',
  // The analysis worker (src/studio/analysis) is an ES module, like the page.
  worker: { format: 'es' },
  build: {
    outDir: 'dist/studio',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
})
