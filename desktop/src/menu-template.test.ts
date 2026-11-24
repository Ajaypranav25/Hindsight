import { describe, expect, test, vi } from 'vitest'
import { shortcutList } from '../../src/studio/lib/shortcuts'
import {
  ACCELERATORS,
  HELP_LINKS,
  MENU_IDS,
  menuTemplate,
  type MenuActions,
  type MenuSpec,
} from './menu-template'

function actions(): MenuActions {
  return {
    newProgram: vi.fn(),
    open: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    toggleFullScreen: vi.fn(),
    openExternal: vi.fn(),
    showAbout: vi.fn(),
  }
}

/** Every item in a template, depth first. */
function items(template: readonly MenuSpec[]): MenuSpec[] {
  return template.flatMap((item) => [item, ...items(item.submenu ?? [])])
}

function menu(template: readonly MenuSpec[], label: string): MenuSpec[] {
  const found = template.find((item) => item.label === label || item.role === label)
  if (found?.submenu === undefined) throw new Error(`no ${label} menu`)
  return found.submenu
}

function find(template: readonly MenuSpec[], id: string): MenuSpec {
  const found = items(template).find((item) => item.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}

describe('the application menu', () => {
  test('macOS gets an app menu with About, Hide and Quit; the others do not', () => {
    const mac = menuTemplate('darwin', 'Hindsight', actions())
    const windows = menuTemplate('win32', 'Hindsight', actions())

    expect(mac[0]?.label).toBe('Hindsight')
    expect(menu(mac, 'Hindsight').map((item) => item.role)).toEqual(
      expect.arrayContaining(['about', 'hide', 'hideOthers', 'unhide', 'quit']),
    )
    expect(windows[0]?.label).toBe('File')
  })

  test('File carries New, Open, Save and Save As to their actions', () => {
    // Arrange
    const handlers = actions()
    const template = menuTemplate('linux', 'Hindsight', handlers)

    // Act
    for (const id of [MENU_IDS.new, MENU_IDS.open, MENU_IDS.save, MENU_IDS.saveAs])
      find(template, id).click?.()

    // Assert
    expect(find(template, MENU_IDS.new).accelerator).toBe(ACCELERATORS.new)
    expect(find(template, MENU_IDS.save).accelerator).toBe('CmdOrCtrl+S')
    expect(find(template, MENU_IDS.saveAs).accelerator).toBe('CmdOrCtrl+Shift+S')
    expect(find(template, MENU_IDS.open).accelerator).toBe('CmdOrCtrl+O')
    expect(handlers.newProgram).toHaveBeenCalledOnce()
    expect(handlers.open).toHaveBeenCalledOnce()
    expect(handlers.save).toHaveBeenCalledOnce()
    expect(handlers.saveAs).toHaveBeenCalledOnce()
  })

  test('Edit has the roles macOS needs for clipboard shortcuts in the editor', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const roles = menu(menuTemplate(platform, 'Hindsight', actions()), 'Edit').map(
        (item) => item.role,
      )

      expect(roles).toEqual(
        expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
      )
    }
  })

  test('only macOS has Open Recent', () => {
    const recent = (platform: string) =>
      items(menuTemplate(platform, 'Hindsight', actions())).some(
        (item) => item.role === 'recentDocuments',
      )

    expect(recent('darwin')).toBe(true)
    expect(recent('win32')).toBe(false)
  })

  test('Help links to the project, its issues and its releases', () => {
    // Arrange
    const handlers = actions()
    const help = menu(menuTemplate('win32', 'Hindsight', handlers), 'help')

    // Act
    for (const item of help) item.click?.()

    // Assert
    expect(handlers.openExternal).toHaveBeenCalledWith(HELP_LINKS.repository)
    expect(handlers.openExternal).toHaveBeenCalledWith(HELP_LINKS.issues)
    expect(handlers.openExternal).toHaveBeenCalledWith(HELP_LINKS.releases)
    expect(handlers.showAbout).toHaveBeenCalledOnce()
  })

  test('About lives in the app menu on macOS rather than in Help', () => {
    const template = menuTemplate('darwin', 'Hindsight', actions())

    expect(items(template).some((item) => item.id === MENU_IDS.about)).toBe(false)
  })

  test('no menu shortcut takes a key the studio uses', () => {
    // Arrange: the studio's keys, and Ctrl+Enter written as Electron writes accelerators.
    const studioKeys = new Set(
      shortcutList(false)
        .flatMap((shortcut) => shortcut.keys)
        .map((key) => key.replace('Ctrl+', 'CmdOrCtrl+')),
    )
    const full = (platform: string) =>
      find(menuTemplate(platform, 'Hindsight', actions()), MENU_IDS.fullScreen)

    // Act
    const accelerators = ['darwin', 'win32', 'linux'].flatMap((platform) =>
      items(menuTemplate(platform, 'Hindsight', actions())).flatMap((item) =>
        item.accelerator === undefined ? [] : [item.accelerator],
      ),
    )

    // Assert: and full screen is not on F11 (Step into) where Electron would put it.
    for (const accelerator of accelerators) expect(studioKeys.has(accelerator)).toBe(false)
    expect(full('win32').role).toBeUndefined()
    expect(full('linux').accelerator).toBeUndefined()
    expect(full('darwin').role).toBe('togglefullscreen')
  })

  test('full screen on Windows and Linux runs its action', () => {
    const handlers = actions()

    find(menuTemplate('win32', 'Hindsight', handlers), MENU_IDS.fullScreen).click?.()

    expect(handlers.toggleFullScreen).toHaveBeenCalledOnce()
  })
})
