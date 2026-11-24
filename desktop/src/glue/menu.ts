import { Menu } from 'electron'
import { APP_NAME } from '../identity'
import { menuTemplate, type MenuActions } from '../menu-template'

export function installMenu(actions: MenuActions): void {
  const template = menuTemplate(process.platform, APP_NAME, actions)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
