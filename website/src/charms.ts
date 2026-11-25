/**
 * The glossy charms that hang in the hero, built from Three.js primitives (no model files): the app
 * icon, a rewind button, a pair of braces, an hourglass, a replay loop and a string of beads. Each
 * charm's origin is the ring it hangs from, so its body lies below (negative y). The same builders
 * render the small icons in the page (scripts/render-icons.mjs).
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export type CharmKind = 'icon' | 'rewind' | 'braces' | 'hourglass' | 'loop' | 'beads'

export const CHARM_KINDS: readonly CharmKind[] = [
  'icon',
  'rewind',
  'braces',
  'hourglass',
  'loop',
  'beads',
]

/** Hindsight's palette (the studio's tokens), as glossy materials. */
export interface Materials {
  readonly paper: THREE.Material
  readonly ink: THREE.Material
  readonly pen: THREE.Material
  readonly cobalt: THREE.Material
  readonly sage: THREE.Material
  readonly chrome: THREE.Material
  readonly glass: THREE.Material
}

export function createMaterials(): Materials {
  const glossy = (color: string, roughness = 0.32) =>
    new THREE.MeshPhysicalMaterial({
      color,
      roughness,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    })
  return {
    paper: glossy('#f3f6f1', 0.42),
    ink: glossy('#17202b', 0.28),
    pen: glossy('#c42c1d', 0.3),
    cobalt: glossy('#2440d6', 0.26),
    sage: glossy('#a9c8a2', 0.36),
    chrome: new THREE.MeshPhysicalMaterial({ color: '#dfe5ea', metalness: 1, roughness: 0.16 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: '#eef5ff',
      transparent: true,
      opacity: 0.45,
      roughness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      iridescence: 0.7,
      iridescenceIOR: 1.4,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  }
}

/** The name of the parts a charm hangs by, which its icon leaves out. */
export const HANGER = 'hanger'

/** The ring a charm hangs from, at its origin. */
function hangingRing(m: Materials): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.032, 12, 32), m.chrome)
  ring.rotation.y = Math.PI / 2
  ring.position.y = -0.1
  ring.name = HANGER
  return ring
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geometry, material)
}

/** A tube through `points` with round joints, so sharp corners stay clean. */
function polylineTube(points: readonly THREE.Vector3[], radius: number, m: THREE.Material) {
  const group = new THREE.Group()
  const path = new THREE.CurvePath<THREE.Vector3>()
  for (let i = 1; i < points.length; i++) path.add(new THREE.LineCurve3(points[i - 1]!, points[i]!))
  group.add(mesh(new THREE.TubeGeometry(path, 160, radius, 12, false), m))
  for (const point of points) {
    const joint = mesh(new THREE.SphereGeometry(radius, 16, 12), m)
    joint.position.copy(point)
    group.add(joint)
  }
  return group
}

/** The app icon: a rounded tile with the program's trace and the red pen standing in it. */
function icon(m: Materials): THREE.Group {
  const group = new THREE.Group()
  const size = 1.5
  const depth = 0.36
  const tile = mesh(new RoundedBoxGeometry(size, size, depth, 6, 0.3), m.paper)
  tile.position.y = -0.2 - size / 2
  group.add(tile)
  // The favicon's trace: M3 22 h6 l3-8 4 8 3-12 3 6 h7, in a 32-unit box.
  const unit = (size * 0.9) / 32
  const at = (x: number, y: number) =>
    new THREE.Vector3((x - 16) * unit, tile.position.y + (16 - y) * unit, depth / 2 + 0.03)
  const trace = [at(3, 22), at(9, 22), at(12, 14), at(16, 22), at(19, 10), at(22, 16), at(29, 16)]
  group.add(polylineTube(trace, 0.055, m.ink))
  const pen = mesh(new THREE.CapsuleGeometry(0.055, size * 0.66, 6, 16), m.pen)
  pen.position.set((22 - 16) * unit, tile.position.y, depth / 2 + 0.07)
  group.add(pen, hangingRing(m))
  return group
}

/** A rewind button: two bevelled triangles pointing back. */
function rewind(m: Materials): THREE.Group {
  const group = new THREE.Group()
  const triangle = new THREE.Shape()
  triangle.moveTo(0.42, 0.52)
  triangle.lineTo(0.42, -0.52)
  triangle.lineTo(-0.42, 0)
  triangle.closePath()
  const geometry = new THREE.ExtrudeGeometry(triangle, {
    depth: 0.26,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.07,
    bevelSegments: 5,
    curveSegments: 4,
  })
  geometry.center()
  for (const x of [-0.36, 0.36]) {
    const part = mesh(geometry, m.pen)
    part.position.set(x, -0.82, 0)
    group.add(part)
  }
  const bar = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 12), m.chrome)
  bar.rotation.z = Math.PI / 2
  bar.position.y = -0.22
  bar.name = HANGER
  group.add(bar, hangingRing(m))
  return group
}

/** A brace as a tube: `side` 1 is "{", -1 is "}". */
function brace(side: 1 | -1, m: THREE.Material): THREE.Mesh {
  const s = side
  const points = [
    [0.26, 0.9],
    [0.06, 0.84],
    [0.02, 0.56],
    [0.02, 0.22],
    [-0.2, 0.0],
    [0.02, -0.22],
    [0.02, -0.56],
    [0.06, -0.84],
    [0.26, -0.9],
  ].map(([x, y]) => new THREE.Vector3(s * x!, y!, 0))
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 120, 0.075, 14), m)
}

/** A pair of braces around a red bead, joined by a chrome bar. */
function braces(m: Materials): THREE.Group {
  const group = new THREE.Group()
  const centre = -1.15
  const left = brace(1, m.cobalt)
  left.position.set(-0.48, centre, 0)
  const right = brace(-1, m.cobalt)
  right.position.set(0.48, centre, 0)
  const bead = mesh(new THREE.SphereGeometry(0.17, 32, 24), m.pen)
  bead.position.y = centre
  const bar = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 12), m.chrome)
  bar.rotation.z = Math.PI / 2
  bar.position.y = -0.24
  bar.name = HANGER
  group.add(left, right, bead, bar, hangingRing(m))
  return group
}

/** An hourglass: glass bulbs between ink caps, red sand running down. */
function hourglass(m: Materials): THREE.Group {
  const group = new THREE.Group()
  const centre = -1.2
  const profile = [
    [0.04, -0.82],
    [0.34, -0.74],
    [0.46, -0.46],
    [0.34, -0.16],
    [0.07, 0],
    [0.34, 0.16],
    [0.46, 0.46],
    [0.34, 0.74],
    [0.04, 0.82],
  ].map(([x, y]) => new THREE.Vector2(x!, y!))
  const glass = mesh(new THREE.LatheGeometry(profile, 48), m.glass)
  glass.position.y = centre
  glass.renderOrder = 1
  const sandBelow = mesh(new THREE.ConeGeometry(0.33, 0.34, 40), m.pen)
  sandBelow.position.y = centre - 0.6
  const sandAbove = mesh(new THREE.ConeGeometry(0.2, 0.22, 40), m.pen)
  sandAbove.rotation.x = Math.PI
  sandAbove.position.y = centre + 0.3
  const stream = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.72, 8), m.pen)
  stream.position.y = centre - 0.08
  group.add(glass, sandBelow, sandAbove, stream)
  for (const y of [0.9, -0.9]) {
    const cap = mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.12, 48), m.ink)
    cap.position.y = centre + y
    group.add(cap)
  }
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 0.4
    const post = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 10), m.chrome)
    post.position.set(Math.cos(angle) * 0.52, centre, Math.sin(angle) * 0.52)
    group.add(post)
  }
  group.add(hangingRing(m))
  return group
}

/** A replay loop: a glossy ring that stops short in a red arrowhead. */
function loop(m: Materials): THREE.Group {
  const group = new THREE.Group()
  const radius = 0.6
  const tube = 0.2
  const centre = -0.2 - tube - radius
  const arc = Math.PI * 1.68
  const start = Math.PI / 2 + 0.55
  const ring = mesh(new THREE.TorusGeometry(radius, tube, 32, 120, arc), m.paper)
  ring.rotation.z = start
  ring.position.y = centre
  const end = start + arc
  const tangent = new THREE.Vector3(-Math.sin(end), Math.cos(end), 0)
  const head = mesh(new THREE.ConeGeometry(0.34, 0.5, 40), m.pen)
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent)
  head.position
    .set(Math.cos(end) * radius, centre + Math.sin(end) * radius, 0)
    .addScaledVector(tangent, 0.16)
  const cap = mesh(new THREE.SphereGeometry(tube, 24, 16), m.paper)
  cap.position.set(Math.cos(start) * radius, centre + Math.sin(start) * radius, 0)
  group.add(ring, head, cap, hangingRing(m))
  return group
}

/** A string of cobalt beads ending in a red one. */
function beads(m: Materials): THREE.Group {
  const group = new THREE.Group()
  let y = -0.28
  for (let i = 0; i < 7; i++) {
    const bead = mesh(new THREE.SphereGeometry(0.13, 24, 18), m.cobalt)
    bead.position.y = y
    const spacer = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 16), m.chrome)
    spacer.position.y = y - 0.155
    group.add(bead, spacer)
    y -= 0.31
  }
  const last = mesh(new THREE.SphereGeometry(0.22, 32, 24), m.pen)
  last.position.y = y - 0.08
  group.add(last, hangingRing(m))
  return group
}

const BUILDERS: Record<CharmKind, (m: Materials) => THREE.Group> = {
  icon,
  rewind,
  braces,
  hourglass,
  loop,
  beads,
}

export function buildCharm(kind: CharmKind, m: Materials): THREE.Group {
  const group = BUILDERS[kind](m)
  group.name = kind
  return group
}

/** The distance below the origin of a charm's middle (where the pointer brushes it). */
export function charmCentre(kind: CharmKind): number {
  return { icon: -0.95, rewind: -0.82, braces: -1.15, hourglass: -1.2, loop: -1.0, beads: -1.3 }[
    kind
  ]
}

/** A chrome chain of `links` links hanging down from the origin; returns it and its length. */
export function buildChain(links: number, m: Materials): { group: THREE.Group; length: number } {
  const group = new THREE.Group()
  const geometry = new THREE.TorusGeometry(0.1, 0.028, 10, 24)
  geometry.scale(1, 1.55, 1)
  const pitch = 0.235
  for (let i = 0; i < links; i++) {
    const link = new THREE.Mesh(geometry, m.chrome)
    link.position.y = -i * pitch - 0.12
    link.rotation.y = i % 2 === 0 ? 0 : Math.PI / 2
    group.add(link)
  }
  return { group, length: links * pitch }
}
