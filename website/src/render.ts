/**
 * Draws one charm alone, centred on a transparent canvas (render.html?charm=icon). Only
 * scripts/render-icons.mjs loads it, to make the small icons the page shows between its words.
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { buildCharm, CHARM_KINDS, createMaterials, HANGER, type CharmKind } from './charms'

const requested = new URLSearchParams(location.search).get('charm') ?? 'icon'
const kind: CharmKind = (CHARM_KINDS as readonly string[]).includes(requested)
  ? (requested as CharmKind)
  : 'icon'

const canvas = document.querySelector<HTMLCanvasElement>('#charm')!
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
})
renderer.setPixelRatio(1)
renderer.setSize(512, 512, false)
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1.05
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
const key = new THREE.DirectionalLight('#ffffff', 1.6)
key.position.set(-4, 6, 8)
scene.add(key, new THREE.AmbientLight('#eef2ff', 0.35))

const charm = buildCharm(kind, createMaterials())
// What it hangs by is no part of an icon.
for (const part of charm.children.filter((child) => child.name === HANGER)) part.removeFromParent()
charm.rotation.set(0.12, kind === 'hourglass' ? 0.3 : -0.38, kind === 'beads' ? 0.22 : 0.04)
const box = new THREE.Box3().setFromObject(charm)
const centre = box.getCenter(new THREE.Vector3())
charm.position.sub(centre)
scene.add(charm)

const size = box.getSize(new THREE.Vector3())
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
const fit = Math.max(size.x, size.y) / 2 / Math.tan(THREE.MathUtils.degToRad(15))
camera.position.set(0, 0, fit * 1.02 + size.z)
camera.lookAt(0, 0, 0)

renderer.render(scene, camera)
;(window as unknown as { charmReady: boolean }).charmReady = true
