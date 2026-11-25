// Makes the site's media in public/media from the repository's own material:
//
//   node scripts/make-media.mjs <frames-dir>
//
// <frames-dir> holds the studio demo's frames (frame-0000.png …), which the repository's demo
// recorder keeps with:  npx tsx scripts/demo-gif.ts --keep-frames   (run at the repository root).
// They become demo.mp4 (H.264) and demo.webm (VP9) at full size, plus a poster image. The README's
// screenshots (docs/images) become WebP images. Needs ffmpeg on the PATH.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(site, 'public', 'media')
const images = resolve(site, '..', 'docs', 'images')
const frames = process.argv[2]

/** The demo was captured at one frame per 230 ms step. */
const FRAME_RATE = String(1000 / 230)
const SCREENSHOTS = ['heap', 'bug-finder']

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
}

mkdirSync(out, { recursive: true })
if (frames === undefined || !existsSync(join(frames, 'frame-0000.png'))) {
  console.error('Usage: node scripts/make-media.mjs <frames-dir with frame-0000.png …>')
  process.exit(1)
}
const input = ['-framerate', FRAME_RATE, '-i', join(frames, 'frame-%04d.png')]
// Each step is held as a still, so a 24 fps stream of duplicated frames plays smoothly everywhere.
const timing = ['-vf', 'fps=24,format=yuv420p']
ffmpeg([
  ...input,
  ...timing,
  '-c:v',
  'libx264',
  '-crf',
  '24',
  '-preset',
  'slow',
  '-movflags',
  '+faststart',
  '-an',
  join(out, 'demo.mp4'),
])
ffmpeg([
  ...input,
  ...timing,
  '-c:v',
  'libvpx-vp9',
  '-crf',
  '36',
  '-b:v',
  '0',
  '-an',
  join(out, 'demo.webm'),
])
ffmpeg([
  '-i',
  join(frames, 'frame-0000.png'),
  '-vf',
  'scale=1440:-1',
  '-q:v',
  '82',
  join(out, 'demo-poster.webp'),
])
for (const name of SCREENSHOTS) {
  ffmpeg([
    '-i',
    join(images, `${name}.png`),
    '-vf',
    'scale=1600:-1',
    '-q:v',
    '80',
    join(out, `${name}.webp`),
  ])
}
console.log(`Media written to ${out}`)
