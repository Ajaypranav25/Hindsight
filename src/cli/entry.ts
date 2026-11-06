import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * True when `scriptPath` (the path Node was started with, `process.argv[1]`) is the module at
 * `moduleUrl`. Both are resolved through links first: npm installs the command as a link named
 * `hindsight`, while Node gives the main module the URL of the link's target.
 */
export function isEntryPoint(scriptPath: string | undefined, moduleUrl: string): boolean {
  if (!scriptPath) return false
  let script: string
  let module: string
  try {
    script = realpathSync.native(scriptPath)
    module = realpathSync.native(fileURLToPath(moduleUrl))
  } catch {
    // A path that does not resolve cannot be this module.
    return false
  }
  return process.platform === 'win32'
    ? script.toLowerCase() === module.toLowerCase()
    : script === module
}
