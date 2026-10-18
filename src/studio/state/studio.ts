/** The real studio store, wired to the core. Only main.tsx imports this module. */
import { compile, recordAsync } from '../../core/index'
import { EXAMPLES } from '../examples'
import { sourceFromFragment } from '../lib/share'
import { browserStorage } from '../lib/storage'
import { browserScheduler } from './scheduler'
import { createStudioStore } from './store'
import type { Engine } from './types'

const engine: Engine = { compile, recordAsync }

function sharedSourceFromLocation(): string | null {
  try {
    return sourceFromFragment(globalThis.location?.hash ?? '')
  } catch {
    return null
  }
}

export const studioStore = createStudioStore(
  { engine, storage: browserStorage(), scheduler: browserScheduler, examples: EXAMPLES },
  { sharedSource: sharedSourceFromLocation() },
)
