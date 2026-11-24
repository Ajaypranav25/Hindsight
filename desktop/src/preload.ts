/**
 * The preload script: exposes the DesktopBridge (src/studio/desktop/bridge.ts) to the studio as
 * `window.hindsightDesktop`. It runs sandboxed and context-isolated, so the page reaches the app
 * only through these functions, and every message from the main process is checked before a
 * listener sees it.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  DESKTOP_BRIDGE_KEY,
  type DesktopBridge,
  type DesktopDocumentState,
  type DesktopSaveRequest,
  type DesktopSaveResult,
} from '../../src/studio/desktop/bridge'
import {
  CHANNELS,
  parseCommand,
  parseOpenRequest,
  parseSaveResult,
  platformOf,
  versionFromArgv,
} from './messages'

function subscribe<T>(
  channel: string,
  parse: (payload: unknown) => T | null,
  listener: (value: T) => void,
): () => void {
  if (typeof listener !== 'function') throw new TypeError('The listener must be a function.')
  const handler = (_event: IpcRendererEvent, payload: unknown) => {
    const value = parse(payload)
    if (value !== null) listener(value)
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

async function saveProgram(request: DesktopSaveRequest): Promise<DesktopSaveResult> {
  try {
    // Only the contract's fields cross over; the main process checks them again.
    const payload = { source: request?.source, path: request?.path }
    return parseSaveResult(await ipcRenderer.invoke(CHANNELS.saveProgram, payload))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'failed', message: `The program could not be saved: ${message}` }
  }
}

function setDocument(state: DesktopDocumentState): void {
  ipcRenderer.send(CHANNELS.setDocument, { name: state?.name, dirty: state?.dirty })
}

const bridge: DesktopBridge = Object.freeze({
  platform: platformOf(process.platform),
  version: versionFromArgv(process.argv),
  onOpen: (listener: Parameters<DesktopBridge['onOpen']>[0]) =>
    subscribe(CHANNELS.open, parseOpenRequest, listener),
  onCommand: (listener: Parameters<DesktopBridge['onCommand']>[0]) =>
    subscribe(CHANNELS.command, parseCommand, listener),
  saveProgram,
  setDocument,
  ready: () => ipcRenderer.send(CHANNELS.ready),
})

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge)
