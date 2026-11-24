# Hindsight for the desktop

The Hindsight studio as an app for Windows, macOS and Linux: the editor, the time-travel debugger
and every panel of the web studio, plus what only an app can do. It opens `.sight` programs and
`.sighttrace` traces from the file manager or File > Open, saves programs back to disk, and opens
`hindsight://` program links. It runs entirely offline.

It is an [Electron](https://www.electronjs.org) shell around the studio in `src/studio`, built from
the same code, and packaged with [electron-builder](https://www.electron.build).

## Download

Each release on GitHub carries the installers, under names that never change, so
`https://github.com/Ajaypranav25/Hindsight/releases/latest/download/<name>` is always the newest:

| System                 | File                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| Windows 10 and 11      | `Hindsight-Setup-x64.exe`                                                 |
| macOS (Apple Silicon)  | `Hindsight-mac-arm64.dmg` (or `.zip`)                                     |
| macOS (Intel)          | `Hindsight-mac-x64.dmg` (or `.zip`)                                       |
| Linux (Debian, Ubuntu) | `Hindsight-linux-amd64.deb` (see [below](#linux-the-deb-or-the-appimage)) |
| Linux (any)            | `Hindsight-linux-x86_64.AppImage`                                         |

`SHA256SUMS.txt` lists the checksum of each (`sha256sum -c SHA256SUMS.txt --ignore-missing`).
Releases from a tag with a hyphen (`v0.6.0-rc.1`) are prereleases: they never become the latest.

### The warnings you will see

The app is not yet signed with a paid certificate, so each system warns before its first start.

- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then **Run
  anyway**. The installer needs no administrator rights: it installs for you alone, in
  `%LOCALAPPDATA%\Programs\hindsight-desktop` (named after the package), and Settings > Apps
  removes it.
- **macOS:** the app is signed ad hoc, not by an identified developer, so macOS says it "cannot be
  opened" (or that Apple "could not verify" it). Drag it to Applications, try to open it once, then
  open **System Settings > Privacy & Security** and choose **Open Anyway**. Or clear the quarantine
  flag in Terminal: `xattr -dr com.apple.quarantine /Applications/Hindsight.app`.

### Linux: the `.deb` or the AppImage

On Debian and Ubuntu, prefer the `.deb`: `sudo apt install ./Hindsight-linux-amd64.deb`. It
installs an AppArmor profile for the app, so Chromium's sandbox works on Ubuntu 24.04 too, and it
registers the app for `.sight` and `.sighttrace` files and `hindsight://` links.

The AppImage runs on any distribution, with some caveats:

- Make it executable first: `chmod +x Hindsight-linux-x86_64.AppImage`.
- It needs FUSE 2, which Ubuntu 22.04 and later do not install: `sudo apt install libfuse2` (on
  Ubuntu 24.04, `sudo apt install libfuse2t64`). Or run it without FUSE:
  `./Hindsight-linux-x86_64.AppImage --appimage-extract-and-run`.
- Where AppArmor blocks unprivileged user namespaces (Ubuntu 24.04 and later), Chromium cannot set
  up its sandbox, and the AppImage's launcher then starts the app with `--no-sandbox`: it runs, but
  without Chromium's sandbox.
- Double-clicking files and opening `hindsight://` links need the app registered with the desktop,
  which an AppImage does not do by itself; a desktop-integration tool such as AppImageLauncher
  does it.

## Commands

The app has its own `package.json` and lockfile, like the VS Code extension in `editors/vscode`.

```sh
npm run build:studio   # at the repository root first: the app ships the built studio

cd desktop
npm ci
npm run build          # bundles dist/main.js and dist/preload.js, copies the studio to dist/studio
npm start              # runs the app from the build
npm run typecheck      # the whole app, Electron glue included, against Electron's types
npm run pack           # the unpacked app, in release/<platform>-unpacked (release/mac-arm64, ...)
npm run dist           # the installers for this system, in release/
npm run e2e            # Playwright drives the built app (npm run build first)
npm run icon           # renders build/icon.png from editors/vscode/icon.svg
```

`npm run dist` builds only what the system it runs on can build: the NSIS installer on Windows, the
DMG and ZIP for both Mac architectures on macOS, and the AppImage and `.deb` on Linux. Releases
build all of them, each on its own system, in CI.

`npm run e2e` starts the app from `dist/` as `npm start` does. To test a packaged app instead,
point `HINDSIGHT_DESKTOP_APP` at its executable (relative to this folder), for example
`HINDSIGHT_DESKTOP_APP=release/win-unpacked/Hindsight.exe npm run e2e` after `npm run pack`. Each
test gets its own user-data folder (`HINDSIGHT_USER_DATA_DIR`) and does not register itself as the
`hindsight://` handler (`HINDSIGHT_NO_PROTOCOL_CLIENT=1`). On Linux, run the tests under
`xvfb-run` when there is no display.

The modules in `src/` that do not import Electron (everything but `main.ts`, `preload.ts` and
`src/glue/`) are unit-tested by the repository's own test suite: `npm test` at the root.

## How it works

```
main process (src/main.ts, src/glue/)                  renderer (sandboxed, context-isolated)
  app://studio/  ─────── serves dist/studio ─────────▶  the studio (src/studio)
  menus, dialogs, files, hindsight:// links                  │  window.hindsightDesktop
  ipcMain ◀──────────── hindsight:* channels ─────────── preload (src/preload.ts)
```

- **The studio is served from `app://studio/`**, a custom scheme registered as standard and
  secure: the page gets a real origin (its local storage persists) and a secure context (the
  clipboard API works), and can reach nothing on disk but the studio's own files. Every response
  carries a strict Content-Security-Policy: scripts, styles, fonts, workers and requests come from
  the app itself, never from the network.
- **The bridge.** The studio and the app share one contract, `src/studio/desktop/bridge.ts`. The
  preload script exposes it to the page as `window.hindsightDesktop`: the app tells the studio what
  to open (`onOpen`) and which menu command was chosen (`onCommand`); the studio asks the app to
  save (`saveProgram`), reports the document's name and unsaved state (`setDocument`), and says when
  it is listening (`ready`). Underneath are five IPC channels (`src/messages.ts`):
  `hindsight:open` and `hindsight:command` to the page, `hindsight:save-program` (an invoke),
  `hindsight:set-document` and `hindsight:ready` from it.
- **Security**, following Electron's checklist: the page runs in Chromium's sandbox (except where
  an AppImage has to start without it, above) and is context-isolated with Node.js off; it cannot
  open windows or navigate away from the studio (web links open in the default browser); every
  permission but writing to the clipboard is denied; every IPC message must come from the studio
  page in the app's window and is validated in both directions; the app writes only to files the
  user chose in this session. The installers switch off Electron's run-as-node, `NODE_OPTIONS` and
  `--inspect` fuses; on Windows and macOS they also check the app archive's integrity at start
  (Electron has no such check on Linux).
- **Opening things.** Files and links arrive on the command line (Windows and Linux, and a second
  launch hands them to the running app), as macOS `open-file` and `open-url` events, or from File >
  Open. Programs are read as UTF-8 (at most 5 MB), traces as bytes (at most 32 MB), and requests
  wait until the studio calls `ready()`. A file whose name the studio could not be handed is an
  error message, never dropped in silence. Electron itself refuses to start when anything follows a
  URL on its command line, so a crafted link cannot smuggle in switches.
- **Unsaved changes.** The window names its document in the title, marked with a dot while it has
  unsaved changes (`● fib.sight — Hindsight`). Closing or quitting with unsaved changes asks Save /
  Don't Save / Cancel, and so does anything that would replace the program (File > Open, File >
  New, a file or link handed to the app); requests that come while the question is open wait with
  it. Save closes the window, or lets the new program in, once the studio's save has succeeded and
  it reports the document clean; a save that fails or takes over 10 seconds keeps the window and
  the program as they are (and ends a quit in progress). The rules are pure state machines
  (`src/document.ts`, `src/replace-guard.ts`), tested without a window.
- **Saving** is atomic (`src/atomic-write.ts`): the program goes to a new file beside the target,
  which then replaces it in one rename, so a full disk or an I/O error never leaves a half-written
  file. Symbolic links are followed and the file's permissions are kept.
- **The window** remembers its size and place, and offers to reload a page that stopped working.

## Releases

Pushing a version tag (`v0.5.0`) runs `.github/workflows/release.yml`. Besides publishing the
`hindsight-lang` package to npm, it checks that the tag matches `desktop/package.json`, packs the
app and runs the end-to-end tests on Windows, macOS and Linux, builds the installers there, and
publishes them with `SHA256SUMS.txt` as the tag's GitHub release. Nothing is published until
everything has built and passed: npm waits for the installers, and the GitHub release for both. A
tag with a hyphen makes a prerelease. The app's version always equals the language package's (a
root test checks it), so bump both together.

CI (`.github/workflows/ci.yml`) packs the app and runs the end-to-end tests on all three systems for
every change, checks the macOS signatures, and on `main` also keeps the installers as workflow
artifacts for 14 days.

## Signing it properly later

Nothing here needs secrets today. When certificates exist, electron-builder signs during
`npm run dist` from environment variables, so they become repository secrets passed to the release
job's `npm run dist` step.

- **Windows:** a code-signing certificate (an EV certificate, or Azure Trusted Signing, earns
  SmartScreen's trust fastest). For a `.pfx` file set `CSC_LINK` (the file, base64-encoded or a
  path) and `CSC_KEY_PASSWORD`; for Azure Trusted Signing, add `win.azureSignOptions` to
  `electron-builder.cjs` and the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`
  variables.
- **macOS:** an Apple Developer ID Application certificate. Export it as a `.p12` and set
  `CSC_LINK` and `CSC_KEY_PASSWORD`; in `electron-builder.cjs` remove `identity: '-'` and
  `timestamp: 'none'`, and set `hardenedRuntime: true`. Then notarize, so Gatekeeper opens the app
  without a warning: set `mac.notarize: true` and either `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or an App Store Connect API key
  (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
- **Linux** has no system-wide signing; the checksums in `SHA256SUMS.txt` are what users verify.
