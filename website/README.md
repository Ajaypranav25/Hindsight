# The Hindsight website

The download page for the Hindsight desktop app: a static site built with Vite, with a Three.js
hero of charms hanging on chains (`src/hero.ts`, built from primitives in `src/charms.ts`).

```sh
cd website
npm ci
npm run dev        # http://localhost:5173
npm run build      # the static site in dist/ (relative URLs: it works at a root or under a path)
npm run preview
```

## Downloads

The installers have version-less names, so the links always serve the newest release:
`https://github.com/Ajaypranav25/Hindsight/releases/latest/download/<name>` (`src/download.ts`).
The page detects the visitor's system and, where the browser says, a Mac's chip. GitHub's API adds
the version, the date and each file's size; when it cannot be reached the page still works.

## Media

Everything in `public/` comes from the repository itself:

- `npm run media -- <frames-dir>` makes the studio video (`demo.mp4`, `demo.webm`, its poster) from
  the frames the repository's demo recorder keeps (`npx tsx scripts/demo-gif.ts --keep-frames` at
  the repository root), and WebP copies of the README's screenshots. Needs ffmpeg.
- `npm run icons` renders each charm alone into `public/icons/` (the small icons between the
  statement's words and on the feature cards) and a still of the hero for browsers without WebGL.
  It uses the installed Chrome through the repository's Playwright.

The hero respects `prefers-reduced-motion` (the charms hang still) and pauses when it is off screen
or the tab is hidden.
