/**
 * The hero's 3D scene: charms hanging on chains from above the top of the page. Each chain has two
 * joints, so it bends: the upper half swings from the anchor and the lower half (with the charm)
 * lags behind it like a real chain, and a slow breeze keeps everything moving. The pointer brushes
 * the chains and charms it passes over, charms lean toward a pointer that comes near, and a click
 * or tap sets one swinging. With reduced motion the charms hang still.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildChain, buildCharm, charmCentre, createMaterials, type CharmKind } from './charms'

interface Placement {
  readonly kind: CharmKind
  /** Where the chain is fixed, in scene units (the view is about 7.5 units tall). */
  readonly x: number
  readonly links: number
  readonly scale: number
  readonly depth: number
}

/** Wide screens: a cluster up and to the right, leaving the headline's corner clear. */
const WIDE: readonly Placement[] = [
  { kind: 'hourglass', x: -1.3, links: 8, scale: 0.8, depth: -1.2 },
  { kind: 'beads', x: -0.15, links: 5, scale: 0.85, depth: -0.5 },
  { kind: 'icon', x: 1.1, links: 11, scale: 1.2, depth: 0.6 },
  { kind: 'loop', x: 2.55, links: 6, scale: 0.9, depth: -0.2 },
  { kind: 'braces', x: 3.75, links: 11, scale: 0.8, depth: -1.0 },
  { kind: 'rewind', x: 4.75, links: 10, scale: 0.78, depth: 0.2 },
]

/** Narrow screens: fewer, smaller charms hanging into the top half. */
const NARROW: readonly Placement[] = [
  { kind: 'hourglass', x: -1.05, links: 11, scale: 0.55, depth: -0.8 },
  { kind: 'icon', x: 0.15, links: 13, scale: 0.85, depth: 0.5 },
  { kind: 'loop', x: 0.95, links: 9, scale: 0.58, depth: -0.3 },
]

/** The chains' anchor, just above the top of the view. */
const ANCHOR_Y = 4.6
const MAX_STEP_S = 1 / 30

/** The upper joint: a slow swing from the anchor. */
const UPPER = { stiffness: 2.6, damping: 1.1 }
/** The lower joint: stiffer and quicker, thrown by the upper joint's motion (the chain's bend). */
const LOWER = { stiffness: 7, damping: 1.8, inertia: 0.9 }
/** How far each joint may swing (radians): lively, but the charms never fly up out of view. */
const MAX_SWING = 0.55
const MAX_BEND = 0.6
/** The fastest a joint may turn (radians per second). */
const MAX_SPIN = 2.2

/** Pointer response: px around a charm or chain that it reacts to, and how hard. */
const REACH_PX = 150
const BRUSH = 0.0055
const LEAN = 0.9
const TAP = 1.3

/** Clamps `value` to ±`limit`. */
function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value))
}

/**
 * A joint near its limit is pushed back softly (so it slows down instead of hitting a wall),
 * and its speed is capped.
 */
function settle(joint: Joint, limit: number): void {
  joint.velocity = clamp(joint.velocity, MAX_SPIN)
  const over = Math.abs(joint.angle) - limit * 0.8
  if (over > 0) joint.velocity -= Math.sign(joint.angle) * over * 0.35
  joint.angle = clamp(joint.angle, limit)
}

interface Joint {
  angle: number
  velocity: number
}

interface Pendulum {
  readonly pivot: THREE.Group
  readonly elbow: THREE.Group
  readonly charm: THREE.Group
  readonly twist: number
  readonly reach: number
  readonly phase: number
  readonly upper: Joint
  readonly lower: Joint
  readonly tilt: Joint
}

export interface HeroScene {
  dispose(): void
}

function environment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer)
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
  return texture
}

function easeOutBack(t: number): number {
  const c = 1.4
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

/** Distance from point p to the segment a–b, all in screen pixels. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length))
  return { distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), along: t }
}

export function mountHero(canvas: HTMLCanvasElement, host: HTMLElement): HeroScene {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.environment = environment(renderer)
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(-4, 6, 8)
  scene.add(key, new THREE.AmbientLight('#eef2ff', 0.35))

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(0, 0, 12)

  const materials = createMaterials()
  const root = new THREE.Group()
  scene.add(root)
  let pendulums: Pendulum[] = []
  let layout: readonly Placement[] | null = null

  function build(placements: readonly Placement[]): void {
    root.clear()
    pendulums = placements.map((placement, index) => {
      const upperLinks = Math.max(1, Math.floor(placement.links / 2))
      const upper = buildChain(upperLinks, materials)
      const lower = buildChain(placement.links - upperLinks, materials)
      const pivot = new THREE.Group()
      pivot.position.set(placement.x, ANCHOR_Y, placement.depth)
      pivot.scale.setScalar(placement.scale)
      const elbow = new THREE.Group()
      elbow.position.y = -upper.length
      const charm = buildCharm(placement.kind, materials)
      charm.position.y = -lower.length
      const twist = (index % 2 === 0 ? 1 : -1) * 0.35
      charm.rotation.y = twist
      elbow.add(lower.group, charm)
      pivot.add(upper.group, elbow)
      root.add(pivot)
      const start = still ? 0 : index % 2 === 0 ? 0.22 : -0.18
      return {
        pivot,
        elbow,
        charm,
        twist,
        reach: (upper.length + lower.length - charmCentre(placement.kind)) * placement.scale,
        phase: index * 1.7,
        upper: { angle: start, velocity: 0 },
        lower: { angle: -start * 0.6, velocity: 0 },
        tilt: { angle: 0, velocity: 0 },
      }
    })
  }

  const pointer = { x: 0, y: 0, vx: 0, inside: false, lastX: 0, lastT: 0 }
  const lean = new THREE.Vector2()
  const anchor = new THREE.Vector3()
  const end = new THREE.Vector3()

  function resize(): void {
    const width = host.clientWidth
    const height = host.clientHeight
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const next = width < 760 ? NARROW : WIDE
    if (next !== layout) {
      layout = next
      build(next)
    }
    // Keep the cluster's right edge inside the view on medium widths.
    root.position.x = width < 760 ? 0 : Math.min(0.4, (camera.aspect - 1.75) * 1.8)
  }

  function toScreen(point: THREE.Vector3, width: number, height: number): { x: number; y: number } {
    point.project(camera)
    return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height }
  }

  /** Where a pendulum's chain runs on screen: from its anchor to its charm's middle. */
  function screenLine(p: Pendulum, width: number, height: number) {
    anchor.set(0, 0, 0).applyMatrix4(p.pivot.matrixWorld)
    end.set(0, charmCentre(p.charm.name as CharmKind), 0).applyMatrix4(p.charm.matrixWorld)
    return { a: toScreen(anchor, width, height), b: toScreen(end, width, height) }
  }

  function onPointerMove(event: PointerEvent): void {
    const rect = host.getBoundingClientRect()
    const x = event.clientX - rect.left
    const now = performance.now()
    const dt = Math.max(1, now - pointer.lastT)
    pointer.vx = ((x - pointer.lastX) / dt) * 16
    pointer.lastX = x
    pointer.lastT = now
    pointer.x = x
    pointer.y = event.clientY - rect.top
    pointer.inside = true
  }

  function onPointerLeave(): void {
    pointer.inside = false
  }

  /** A click or tap on a chain or charm swings it away from the pointer. */
  function onPointerDown(event: PointerEvent): void {
    onPointerMove(event)
    const width = host.clientWidth
    const height = host.clientHeight
    for (const p of pendulums) {
      const { a, b } = screenLine(p, width, height)
      const hit = distanceToSegment(pointer.x, pointer.y, a.x, a.y, b.x, b.y)
      const radius = REACH_PX * 0.6 * p.pivot.scale.x
      if (hit.distance > radius) continue
      const side = pointer.x < b.x ? 1 : -1
      p.upper.velocity += side * TAP * (0.4 + hit.along * 0.6)
      p.lower.velocity += side * TAP * 1.3 * hit.along
      p.tilt.velocity += TAP * 0.4
    }
  }

  /**
   * The pointer's effect on every chain and charm near it: a push in the direction it moves
   * (strongest low on the chain, where it swings freely) and a gentle lean toward it.
   */
  function respond(width: number, height: number, dt: number): void {
    if (!pointer.inside) return
    for (const p of pendulums) {
      const { a, b } = screenLine(p, width, height)
      const hit = distanceToSegment(pointer.x, pointer.y, a.x, a.y, b.x, b.y)
      const radius = REACH_PX * p.pivot.scale.x
      if (hit.distance >= radius) continue
      const closeness = 1 - hit.distance / radius
      const push = pointer.vx * BRUSH * closeness
      p.upper.velocity += push * (0.35 + hit.along * 0.65)
      p.lower.velocity += push * 1.4 * hit.along
      const toward = Math.max(-1, Math.min(1, (pointer.x - b.x) / radius))
      p.upper.velocity -= toward * LEAN * closeness * dt
      p.lower.velocity -= toward * LEAN * 0.5 * closeness * dt
    }
    pointer.vx *= 0.55
  }

  function step(dt: number, time: number): void {
    for (const p of pendulums) {
      const breeze = Math.sin(time * 0.55 + p.phase) * 0.06 + Math.sin(time * 1.3 + p.phase) * 0.025
      const upperForce =
        -UPPER.stiffness * p.upper.angle - UPPER.damping * p.upper.velocity + breeze
      p.upper.velocity += upperForce * dt
      p.upper.angle += p.upper.velocity * dt
      settle(p.upper, MAX_SWING)
      // The lower half is thrown the other way when the upper half speeds up: the chain bends.
      const lowerForce =
        -LOWER.stiffness * p.lower.angle -
        LOWER.damping * p.lower.velocity -
        LOWER.inertia * upperForce
      p.lower.velocity += lowerForce * dt
      p.lower.angle += p.lower.velocity * dt
      settle(p.lower, MAX_BEND)
      const tiltForce = -UPPER.stiffness * p.tilt.angle - UPPER.damping * p.tilt.velocity
      p.tilt.velocity += (tiltForce + breeze * 0.5) * dt
      p.tilt.angle += p.tilt.velocity * dt
      settle(p.tilt, MAX_SWING)
    }
  }

  function pose(entrance: number): void {
    for (const [index, p] of pendulums.entries()) {
      p.pivot.rotation.z = p.upper.angle
      p.pivot.rotation.x = p.tilt.angle * 0.6
      p.elbow.rotation.z = p.lower.angle
      p.charm.rotation.y = p.twist + p.tilt.angle * 1.2 + p.lower.velocity * 0.15
      const t = Math.min(1, Math.max(0, (entrance - 0.12 * index) / 1.1))
      p.pivot.position.y = ANCHOR_Y + (1 - easeOutBack(t)) * 6
    }
  }

  let frame = 0
  let running = false
  let visible = true
  let last = performance.now()
  const started = last

  function render(now: number): void {
    const dt = Math.min(MAX_STEP_S, (now - last) / 1000)
    last = now
    const time = (now - started) / 1000
    const width = host.clientWidth
    const height = host.clientHeight
    if (!still) {
      respond(width, height, dt)
      step(dt, time)
      const targetX = pointer.inside ? (pointer.x / width - 0.5) * 0.6 : 0
      const targetY = pointer.inside ? (pointer.y / height - 0.5) * -0.35 : 0
      lean.x += (targetX - lean.x) * 0.04
      lean.y += (targetY - lean.y) * 0.04
      camera.position.x = lean.x
      camera.position.y = lean.y
      camera.lookAt(0, 0, 0)
    }
    pose(still ? 10 : time)
    renderer.render(scene, camera)
    frame = requestAnimationFrame(render)
  }

  function start(): void {
    if (running || still) return
    running = true
    last = performance.now()
    frame = requestAnimationFrame(render)
  }

  function stop(): void {
    running = false
    cancelAnimationFrame(frame)
  }

  function updateRunning(): void {
    if (visible && !document.hidden) start()
    else stop()
  }

  function renderStill(): void {
    pose(10)
    root.updateMatrixWorld(true)
    renderer.render(scene, camera)
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    updateRunning()
  })
  observer.observe(host)
  const resizeObserver = new ResizeObserver(() => {
    resize()
    if (still) renderStill()
  })
  resizeObserver.observe(host)
  document.addEventListener('visibilitychange', updateRunning)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerleave', onPointerLeave)
  host.addEventListener('pointerdown', onPointerDown)

  resize()
  if (still) renderStill()
  else start()

  return {
    dispose() {
      stop()
      observer.disconnect()
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', updateRunning)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('pointerdown', onPointerDown)
      renderer.dispose()
    },
  }
}
