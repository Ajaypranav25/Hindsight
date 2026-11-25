/**
 * Reading and writing the user's files. The page names the file it saves to, so the app writes
 * only to files the user picked in this session (opened, chosen in a Save dialog, or passed to the
 * app by the system); for any other path it asks with a Save dialog first. Saves are atomic
 * (atomic-write.ts): a failed save leaves the file as it was.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import type { DesktopSaveRequest, DesktopSaveResult } from '../../../src/studio/desktop/bridge'
import { writeFileAtomically } from '../atomic-write'
import {
  describeFileError,
  OPEN_FILTERS,
  openRequestFor,
  pathKey,
  SAVE_FILTERS,
  saveDialogStart,
  sizeProblem,
  type OpenResult,
} from '../open-files'

export class UserFiles {
  private readonly granted = new Set<string>()

  constructor(private readonly platform: string) {}

  /** Lets the studio save to `path` from now on: only programs, so a trace is never overwritten. */
  private grant(path: string): void {
    this.granted.add(pathKey(path, this.platform))
  }

  private isGranted(path: string): boolean {
    return this.granted.has(pathKey(path, this.platform))
  }

  /** Reads a program or trace the user asked to open. */
  async read(path: string): Promise<OpenResult> {
    try {
      const info = await stat(path)
      if (!info.isFile()) return { ok: false, message: `${basename(path)} is not a file.` }
      const tooLarge = sizeProblem(path, info.size)
      if (tooLarge !== null) return { ok: false, message: tooLarge }
      const result = openRequestFor(path, new Uint8Array(await readFile(path)), this.platform)
      if (!result.ok) return result
      app.addRecentDocument(path)
      if (result.request.kind === 'program') this.grant(path)
      return result
    } catch (error) {
      const reason = describeFileError(error)
      return { ok: false, message: `${basename(path)} could not be opened because ${reason}.` }
    }
  }

  /** Asks for a program or trace to open; null when the user cancels. */
  async choose(window: BrowserWindow | null): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: 'Open',
      properties: ['openFile'],
      filters: [...OPEN_FILTERS],
    }
    const { canceled, filePaths } = await (window === null
      ? dialog.showOpenDialog(options)
      : dialog.showOpenDialog(window, options))
    return canceled ? null : (filePaths[0] ?? null)
  }

  /** Writes the program where the studio asked, or where the user chooses. */
  async save(window: BrowserWindow, request: DesktopSaveRequest): Promise<DesktopSaveResult> {
    const known = request.path !== null && this.isGranted(request.path)
    const target = known ? request.path : await this.chooseSaveTarget(window, request)
    if (target === null) return { ok: false, reason: 'cancelled' }
    try {
      await writeFileAtomically(target, request.source, this.platform)
    } catch (error) {
      const reason = describeFileError(error)
      const message = `${basename(target)} could not be saved because ${reason}.`
      return { ok: false, reason: 'failed', message }
    }
    this.grant(target)
    app.addRecentDocument(target)
    return { ok: true, path: target, name: basename(target) }
  }

  private async chooseSaveTarget(
    window: BrowserWindow,
    request: DesktopSaveRequest,
  ): Promise<string | null> {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save Program',
      defaultPath: saveDialogStart(request, app.getPath('documents')),
      filters: [...SAVE_FILTERS],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    return canceled || filePath === undefined || filePath === '' ? null : filePath
  }
}
