import { defineConfig } from 'vite'

export default defineConfig({
  // Relative URLs, so the built site works at a domain's root or under a path (GitHub Pages).
  base: './',
  build: {
    target: 'es2022',
    // The hero's 3D scene (three.js, about 150 KB gzipped) is its own chunk, loaded after the page.
    chunkSizeWarningLimit: 700,
  },
})
