/**
 * The app's menus, as a plain template (Electron's Menu.buildFromTemplate takes it as is). The
 * Edit menu's roles are not decoration: on macOS, Cmd+C, Cmd+V and the rest only reach the editor
 * through menu items with those roles.
 *
 * The studio's own shortcuts (src/studio/lib/shortcuts.ts) use F7 to F11, Home, End, Space and
 * Ctrl/Cmd+Enter. Electron's full-screen role takes F11 on Windows and Linux, where it would
 * collide with "Step into", so there it is a plain item without a shortcut.
 */

/** The Electron menu roles this app uses. */
export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'unhide'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'delete'
  | 'selectAll'
  | 'toggleDevTools'
  | 'resetZoom'
  | 'zoomIn'
  | 'zoomOut'
  | 'togglefullscreen'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'front'
  | 'window'
  | 'help'
  | 'recentDocuments'
  | 'clearRecentDocuments'

export interface MenuSpec {
  readonly id?: string
  readonly label?: string
  readonly role?: MenuRole
  readonly type?: 'separator'
  readonly accelerator?: string
  readonly submenu?: MenuSpec[]
  readonly click?: () => void
}

/** What the menu items do; the glue supplies them. */
export interface MenuActions {
  newProgram(): void
  open(): void
  save(): void
  saveAs(): void
  /** Reloads the studio, asking first when that would lose unsaved changes. */
  reload(): void
  toggleFullScreen(): void
  openExternal(url: string): void
  showAbout(): void
}

export const REPOSITORY_URL = 'https://github.com/Ajaypranav25/Hindsight'
export const HELP_LINKS = {
  repository: REPOSITORY_URL,
  issues: `${REPOSITORY_URL}/issues`,
  releases: `${REPOSITORY_URL}/releases`,
} as const

/** Menu item ids, for tests and for enabling items later. */
export const MENU_IDS = {
  new: 'file-new',
  open: 'file-open',
  save: 'file-save',
  saveAs: 'file-save-as',
  reload: 'view-reload',
  fullScreen: 'view-full-screen',
  about: 'help-about',
} as const

export const ACCELERATORS = {
  new: 'CmdOrCtrl+N',
  open: 'CmdOrCtrl+O',
  save: 'CmdOrCtrl+S',
  saveAs: 'CmdOrCtrl+Shift+S',
  reload: 'CmdOrCtrl+R',
} as const

const SEPARATOR: MenuSpec = { type: 'separator' }

function appMenu(appName: string): MenuSpec {
  return {
    label: appName,
    submenu: [
      { role: 'about' },
      SEPARATOR,
      { role: 'services' },
      SEPARATOR,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      SEPARATOR,
      { role: 'quit' },
    ],
  }
}

function fileMenu(mac: boolean, actions: MenuActions): MenuSpec {
  const recent: MenuSpec[] = mac
    ? [
        {
          label: 'Open Recent',
          role: 'recentDocuments',
          submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }],
        },
      ]
    : []
  return {
    label: 'File',
    submenu: [
      { id: MENU_IDS.new, label: 'New', accelerator: ACCELERATORS.new, click: actions.newProgram },
      { id: MENU_IDS.open, label: 'Open…', accelerator: ACCELERATORS.open, click: actions.open },
      ...recent,
      SEPARATOR,
      { id: MENU_IDS.save, label: 'Save', accelerator: ACCELERATORS.save, click: actions.save },
      {
        id: MENU_IDS.saveAs,
        label: 'Save As…',
        accelerator: ACCELERATORS.saveAs,
        click: actions.saveAs,
      },
      SEPARATOR,
      mac ? { role: 'close' } : { role: 'quit', label: 'Exit' },
    ],
  }
}

function editMenu(mac: boolean): MenuSpec {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      SEPARATOR,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
      { role: 'delete' },
      SEPARATOR,
      { role: 'selectAll' },
    ],
  }
}

function viewMenu(mac: boolean, actions: MenuActions): MenuSpec {
  const fullScreen: MenuSpec = mac
    ? { id: MENU_IDS.fullScreen, role: 'togglefullscreen' }
    : { id: MENU_IDS.fullScreen, label: 'Toggle Full Screen', click: actions.toggleFullScreen }
  return {
    label: 'View',
    submenu: [
      // Not the reload role, which would drop unsaved changes without asking.
      {
        id: MENU_IDS.reload,
        label: 'Reload',
        accelerator: ACCELERATORS.reload,
        click: actions.reload,
      },
      { role: 'toggleDevTools' },
      SEPARATOR,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      SEPARATOR,
      fullScreen,
    ],
  }
}

function windowMenu(mac: boolean): MenuSpec {
  const rest: MenuSpec[] = mac
    ? [{ role: 'zoom' }, SEPARATOR, { role: 'front' }, SEPARATOR, { role: 'window' }]
    : [{ role: 'close' }]
  return { label: 'Window', submenu: [{ role: 'minimize' }, ...rest] }
}

function helpMenu(mac: boolean, appName: string, actions: MenuActions): MenuSpec {
  const link = (label: string, url: string): MenuSpec => ({
    label,
    click: () => actions.openExternal(url),
  })
  const about: MenuSpec[] = mac
    ? []
    : [SEPARATOR, { id: MENU_IDS.about, label: `About ${appName}`, click: actions.showAbout }]
  return {
    role: 'help',
    submenu: [
      link(`${appName} on GitHub`, HELP_LINKS.repository),
      link('Report an Issue', HELP_LINKS.issues),
      link('Releases', HELP_LINKS.releases),
      ...about,
    ],
  }
}

/** The application menu for `platform` (process.platform). */
export function menuTemplate(platform: string, appName: string, actions: MenuActions): MenuSpec[] {
  const mac = platform === 'darwin'
  return [
    ...(mac ? [appMenu(appName)] : []),
    fileMenu(mac, actions),
    editMenu(mac),
    viewMenu(mac, actions),
    windowMenu(mac),
    helpMenu(mac, appName, actions),
  ]
}
