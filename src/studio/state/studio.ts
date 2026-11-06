/** The real studio store, wired to the core. Only main.tsx imports this module. */
import { compareRecordings, compile, recordAsync } from '../../core/index'
import { EXAMPLES } from '../examples'
import { takeSharedMoment, watchSharedLinks, type ShareHost } from '../lib/share'
import { browserStorage } from '../lib/storage'
import { browserScheduler } from './scheduler'
import { createStudioStore } from './store'
import type { Engine } from './types'

const engine: Engine = { compile, recordAsync, compare: compareRecordings }
const host = globalThis as ShareHost
const moment = takeSharedMoment(host)

export const studioStore = createStudioStore(
  { engine, storage: browserStorage(), scheduler: browserScheduler, examples: EXAMPLES },
  { sharedSource: moment?.source ?? null, sharedTime: moment?.time ?? null },
)

// A share link pasted into the address bar of an open studio opens like one followed from outside:
// the program it replaces is kept first.
watchSharedLinks(host, (source, time) => studioStore.getState().openSharedSource(source, time))
