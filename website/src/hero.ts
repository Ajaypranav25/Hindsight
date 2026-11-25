/**
 * The hero's 3D scene: glossy charms floating in the air, bobbing and turning slowly. The pointer
 * pushes away the charms it comes near (they spring back to their places), a quick sweep knocks
 * them spinning, and a click sends a burst through the ones around it. The camera leans a little
 * toward the pointer. With reduced motion nothing moves by itself; only the pointer moves things.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildCharm, createMaterials, HANGER, type CharmKind, type Materials } from './charms'

type Kind = CharmKind | 'dot' | 'pen'

interface Placement {
  readonly kind: Kind
  /** Where it floats, in scene units (the view is about 7.5 units tall, centred on 0). */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly scale: number
  /** The way it faces at rest (radians). */
  readonly turn: readonly [number, number, number]
  /** A dot's colour. */
  readonly tone?: 'pen' | 'cobalt' | 'sage'
}

/** Wide screens: a loose cloud up and to the right, leaving the headline's corner clear. */
const WIDE: readonly Placement[] = [
  { kind: 'hourglass', x: -2.6, y: 1.9, z: -1.4, scale: 0.85, turn: [0.15, 0.4, -0.25] },
  { kind: 'loop', x: -0.5, y: 2.45, z: -0.6, scale: 0.85, turn: [0.2, -0.5, 0.3] },
  { kind: 'icon', x: 1.55, y: 1.05, z: 0.9, scale: 1.35, turn: [0.12, -0.42, 0.1] },
  { kind: 'braces', x: 3.6, y: 2.35, z: -0.9, scale: 0.85, turn: [0.1, 0.45, -0.2] },
  { kind: 'rewind', x: 4.8, y: 0.55, z: 0.1, scale: 0.85, turn: [0.25, -0.55, 0.15] },
  { kind: 'pen', x: 5.6, y: 2.6, z: -1.6, scale: 0.9, turn: [0.3, 0.2, -0.9] },
  { kind: 'dot', x: 0.15, y: 0.75, z: 1.7, scale: 0.2, turn: [0, 0, 0], tone: 'pen' },
  { kind: 'dot', x: 2.95, y: -0.35, z: 1.3, scale: 0.15, turn: [0, 0, 0], tone: 'cobalt' },
  { kind: 'dot', x: -1.5, y: 3.0, z: -2.2, scale: 0.24, turn: [0, 0, 0], tone: 'sage' },
  { kind: 'dot', x: 6.3, y: 1.3, z: -0.8, scale: 0.18, turn: [0, 0, 0], tone: 'cobalt' },
]

/** Narrow screens: fewer, smaller charms in the top half. */
const NARROW: readonly Placement[] = [
  { kind: 'hourglass', x: -1.15, y: 2.4, z: -1.0, scale: 0.55, turn: [0.15, 0.4, -0.25] },
  { kind: 'icon', x: 0.2, y: 1.55, z: 0.6, scale: 0.95, turn: [0.12, -0.42, 0.1] },
  { kind: 'loop', x: 1.3, y: 2.95, z: -0.5, scale: 0.5, turn: [0.2, -0.5, 0.3] },
  { kind: 'rewind', x: -1.1, y: 0.75, z: -0.4, scale: 0.5, turn: [0.25, -0.55, 0.15] },
  { kind: 'dot', x: 1.25, y: 0.9, z: 0.9, scale: 0.14, turn: [0, 0, 0], tone: 'pen' },
]

const MAX_STEP_S = 1 / 30
/** The pull back to a charm's place, and how quickly its motion dies down. */
const SPRING = 7
const DAMPING = 3.4
const TURN_SPRING = 5
const TURN_DAMPING = 2.6
/** The pointer's reach (scene units, scaled by the charm), its push, its sweep and its click. */
const REACH = 1.9
const REPEL = 26
const SWEEP = 2.2
const BURST_REACH = 3.2
const BURST = 7
/** The fastest a charm may move (units per second) and turn (radians per second). */
const MAX_SPEED = 9
const MAX_SPIN = 7

interface Floater {
  readonly object: THREE.Group
  readonly rest: THREE.Vector3
  readonly restTurn: THREE.Vector3
  readonly scale: number
  readonly phase: number
  readonly position: THREE.Vector3
  readonly velocity: THREE.Vector3
  readonly turn: THREE.Vector3
  readonly spin: THREE.Vector3
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
  const c = 1.6
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

/** A charm without what it would hang by, turning about its own middle. */
function floatingCharm(kind: CharmKind, m: Materials): THREE.Group {
  const charm = buildCharm(kind, m)
  for (const part of charm.children.filter((child) => child.name === HANGER))
    part.removeFromParent()
  const centre = new THREE.Box3().setFromObject(charm).getCenter(new THREE.Vector3())
  charm.position.sub(centre)
  const holder = new THREE.Group()
  holder.add(charm)
  return holder
}

function accent(placement: Placement, m: Materials): THREE.Group {
  const holder = new THREE.Group()
  if (placement.kind === 'pen') {
    holder.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 1.5, 8, 24), m.pen))
  } else {
    const material =
      placement.tone === 'cobalt' ? m.cobalt : placement.tone === 'sage' ? m.sage : m.pen
    holder.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), material))
  }
  return holder
}

function clampLength(vector: THREE.Vector3, max: number): void {
  if (vector.lengthSq() > max * max) vector.setLength(max)
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
  let floaters: Floater[] = []
  let layout: readonly Placement[] | null = null

  function build(placements: readonly Placement[]): void {
    root.clear()
    floaters = placements.map((placement, index) => {
      const object =
        placement.kind === 'dot' || placement.kind === 'pen'
          ? accent(placement, materials)
          : floatingCharm(placement.kind, materials)
      const rest = new THREE.Vector3(placement.x, placement.y, placement.z)
      const restTurn = new THREE.Vector3(...placement.turn)
      object.position.copy(rest)
      object.rotation.set(restTurn.x, restTurn.y, restTurn.z)
      object.scale.setScalar(still ? placement.scale : 0)
      root.add(object)
      return {
        object,
        rest,
        restTurn,
        scale: placement.scale,
        phase: index * 1.37,
        position: rest.clone(),
        velocity: new THREE.Vector3(),
        turn: restTurn.clone(),
        spin: new THREE.Vector3(),
      }
    })
  }

  // The pointer, in pixels and as a ray into the scene.
  const pointer = { x: 0, y: 0, inside: false, moved: false }
  const ndc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const hit = new THREE.Vector3()
  const lastHit = new THREE.Vector3()
  const sweep = new THREE.Vector3()
  const offset = new THREE.Vector3()
  const lean = new THREE.Vector2()

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
    // Keep the cloud's right edge inside the view on medium widths.
    root.position.x = width < 760 ? 0 : Math.min(0.4, (camera.aspect - 1.8) * 1.9)
  }

  /** Where the pointer meets the plane z = depth (in the cloud's coordinates). */
  function pointerAt(depth: number, target: THREE.Vector3): boolean {
    ndc.set((pointer.x / host.clientWidth) * 2 - 1, -(pointer.y / host.clientHeight) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    plane.constant = -depth
    if (raycaster.ray.intersectPlane(plane, target) === null) return false
    target.x -= root.position.x
    return true
  }

  function onPointerMove(event: PointerEvent): void {
    const rect = host.getBoundingClientRect()
    pointer.x = event.clientX - rect.left
    pointer.y = event.clientY - rect.top
    pointer.inside = true
    pointer.moved = true
  }

  function onPointerLeave(): void {
    pointer.inside = false
  }

  /** A click or tap: every charm near it is thrown outwards and set spinning. */
  function onPointerDown(event: PointerEvent): void {
    onPointerMove(event)
    for (const f of floaters) {
      if (!pointerAt(f.position.z, hit)) continue
      offset.subVectors(f.position, hit).setZ(0)
      const distance = offset.length()
      const reach = BURST_REACH * Math.max(0.6, f.scale)
      if (distance >= reach) continue
      const strength = BURST * (1 - distance / reach)
      if (distance < 0.001) offset.set(0, 1, 0)
      f.velocity.addScaledVector(offset.normalize(), strength)
      f.spin.x += (Math.random() - 0.5) * strength * 1.4
      f.spin.y += (Math.random() - 0.5) * strength * 1.8
      f.spin.z += (Math.random() - 0.5) * strength
    }
  }

  /** The pointer pushes away what it comes near, and a sweep drags things along and spins them. */
  function respond(dt: number): void {
    if (!pointer.inside) return
    if (pointerAt(0, hit)) {
      sweep.subVectors(hit, lastHit).divideScalar(Math.max(dt, 1 / 240))
      if (!pointer.moved) sweep.set(0, 0, 0)
      clampLength(sweep, 40)
      lastHit.copy(hit)
    }
    pointer.moved = false
    for (const f of floaters) {
      if (!pointerAt(f.position.z, hit)) continue
      offset.subVectors(f.position, hit).setZ(0)
      const distance = offset.length()
      const reach = REACH * Math.max(0.55, f.scale)
      if (distance >= reach) continue
      const closeness = 1 - distance / reach
      if (distance > 0.001)
        f.velocity.addScaledVector(offset.normalize(), REPEL * closeness ** 2 * dt)
      f.velocity.addScaledVector(sweep, SWEEP * closeness * dt)
      f.spin.y += sweep.x * 0.9 * closeness * dt
      f.spin.x -= sweep.y * 0.9 * closeness * dt
      f.spin.z -= sweep.x * 0.35 * closeness * dt
    }
  }

  function step(dt: number, time: number): void {
    for (const f of floaters) {
      // Its place, with a slow bob when it may move by itself.
      const bobX = still ? 0 : Math.sin(time * 0.5 + f.phase) * 0.1
      const bobY = still ? 0 : Math.sin(time * 0.7 + f.phase * 1.3) * 0.16
      offset.set(
        f.rest.x + bobX - f.position.x,
        f.rest.y + bobY - f.position.y,
        f.rest.z - f.position.z,
      )
      f.velocity.addScaledVector(offset, SPRING * dt).multiplyScalar(Math.max(0, 1 - DAMPING * dt))
      clampLength(f.velocity, MAX_SPEED)
      f.position.addScaledVector(f.velocity, dt)
      // Its turn, drifting a little around the way it faces.
      const driftY = still ? 0 : Math.sin(time * 0.35 + f.phase) * 0.35
      const driftX = still ? 0 : Math.sin(time * 0.45 + f.phase * 0.7) * 0.12
      offset.set(
        f.restTurn.x + driftX - f.turn.x,
        f.restTurn.y + driftY - f.turn.y,
        f.restTurn.z - f.turn.z,
      )
      f.spin
        .addScaledVector(offset, TURN_SPRING * dt)
        .multiplyScalar(Math.max(0, 1 - TURN_DAMPING * dt))
      clampLength(f.spin, MAX_SPIN)
      f.turn.addScaledVector(f.spin, dt)
    }
  }

  function pose(time: number): void {
    for (const [index, f] of floaters.entries()) {
      f.object.position.copy(f.position)
      f.object.rotation.set(f.turn.x, f.turn.y, f.turn.z)
      if (still) continue
      const t = Math.min(1, Math.max(0, (time - 0.08 * index) / 0.9))
      f.object.scale.setScalar(f.scale * Math.max(0, easeOutBack(t)))
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
    respond(dt)
    step(dt, time)
    const targetX = pointer.inside ? (pointer.x / host.clientWidth - 0.5) * 0.6 : 0
    const targetY = pointer.inside ? (pointer.y / host.clientHeight - 0.5) * -0.35 : 0
    lean.x += (targetX - lean.x) * 0.04
    lean.y += (targetY - lean.y) * 0.04
    camera.position.x = lean.x
    camera.position.y = lean.y
    camera.lookAt(0, 0, 0)
    pose(time)
    renderer.render(scene, camera)
    frame = requestAnimationFrame(render)
  }

  function start(): void {
    if (running) return
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

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    updateRunning()
  })
  observer.observe(host)
  const resizeObserver = new ResizeObserver(() => {
    resize()
    if (!still) return
    pose(10)
    renderer.render(scene, camera)
  })
  resizeObserver.observe(host)
  document.addEventListener('visibilitychange', updateRunning)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerleave', onPointerLeave)
  host.addEventListener('pointerdown', onPointerDown)

  resize()
  start()

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
