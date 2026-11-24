/**
 * The main process's end of the bridge. Every message is checked twice: it must come from the
 * studio page in the app's window (not a frame, not another origin), and its payload must be
 * exactly what the contract allows.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { DesktopSaveRequest, DesktopSaveResult } from '../../../src/studio/desktop/bridge'
import { CHANNELS, parseDocumentState, parseSaveRequest } from '../messages'
import type { StudioWindow } from './studio-window'

export interface IpcHost {
  /** The window whose studio sent `event`, or null when it is not a trusted sender. */
  studioFor(event: IpcMainEvent | IpcMainInvokeEvent): StudioWindow | null
  save(studio: StudioWindow, request: DesktopSaveRequest): Promise<DesktopSaveResult>
}

const INVALID_SAVE: DesktopSaveResult = {
  ok: false,
  reason: 'failed',
  message: 'The program could not be saved: the request was not valid.',
}

export function registerIpc(host: IpcHost): void {
  ipcMain.handle(CHANNELS.saveProgram, async (event, payload: unknown) => {
    const studio = host.studioFor(event)
    if (studio === null) throw new Error('Refused a save from outside the studio.')
    const request = parseSaveRequest(payload)
    const result = request === null ? INVALID_SAVE : await host.save(studio, request)
    studio.saveFinished(result)
    return result
  })
  ipcMain.on(CHANNELS.setDocument, (event, payload: unknown) => {
    const state = parseDocumentState(payload, process.platform)
    if (state !== null) host.studioFor(event)?.setDocument(state)
  })
  ipcMain.on(CHANNELS.ready, (event) => host.studioFor(event)?.markReady())
}
