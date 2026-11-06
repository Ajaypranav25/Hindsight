import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the built studio works from any path (GitHub Pages serves it under
  // /<repository>/, not at the site root).
  base: './',
  build: {
    outDir: 'dist/studio',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
})
