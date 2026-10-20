/** The real studio store, wired to the core. Only main.tsx imports this module. */
import { compile, recordAsync } from '../../core/index'
import { EXAMPLES } from '../examples'
import { takeSharedSource, watchSharedLinks, type ShareHost } from '../lib/share'
import { browserStorage } from '../lib/storage'
import { browserScheduler } from './scheduler'
import { createStudioStore } from './store'
import type { Engine } from './types'

const engine: Engine = { compile, recordAsync }
const host = globalThis as ShareHost

export const studioStore = createStudioStore(
  { engine, storage: browserStorage(), scheduler: browserScheduler, examples: EXAMPLES },
  { sharedSource: takeSharedSource(host) },
)

// A share link pasted into the address bar of an open studio loads like an edit.
watchSharedLinks(host, (source) => studioStore.getState().setSource(source))
