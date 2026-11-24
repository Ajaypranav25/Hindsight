/**
 * electron-builder's configuration (https://www.electron.build). `npm run dist` builds the
 * installers for the current system into release/; `npm run pack` builds only the unpacked app,
 * for the end-to-end tests (scripts/package.mjs).
 *
 * The download site links to https://github.com/Ajaypranav25/Hindsight/releases/latest/download/
 * followed by these artifact names, so they carry no version and must never change.
 *
 * No signing certificates exist yet: Windows and Linux builds are unsigned, macOS builds are signed
 * ad hoc (identity "-"), which Apple Silicon requires for any code to run at all. README.md says how
 * to add real signing later.
 */

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'io.github.ajaypranav25.hindsight',
  productName: 'Hindsight',
  copyright: 'Copyright © 2026 Ajaypranav25',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  // No native modules, nothing to rebuild.
  npmRebuild: false,
  // The studio is in English; other Chromium locales would only add megabytes.
  electronLanguages: ['en-US'],
  // Installers are published by .github/workflows/release.yml, never by electron-builder.
  publish: null,
  // Switches off what an attacker could use to run code through the app's signed executable.
  // scripts/package.mjs turns the debugger switch back on for the build the e2e tests drive.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableCookieEncryption: true,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  fileAssociations: [
    {
      ext: 'sight',
      name: 'Hindsight program',
      description: 'Hindsight program',
      role: 'Editor',
      mimeType: 'text/x-hindsight',
    },
    {
      ext: 'sighttrace',
      name: 'Hindsight trace',
      description: 'Hindsight trace',
      role: 'Viewer',
      mimeType: 'application/x-hindsight-trace',
    },
  ],
  protocols: [{ name: 'Hindsight', schemes: ['hindsight'] }],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  // One click, per user: no administrator rights and no questions, installed in
  // %LOCALAPPDATA%\Programs\Hindsight with Start menu and desktop shortcuts, removable from
  // Settings > Apps. build/installer.nsh (picked up by name) registers hindsight:// links.
  nsis: {
    oneClick: true,
    perMachine: false,
    artifactName: 'Hindsight-Setup-x64.exe',
    shortcutName: 'Hindsight',
    uninstallDisplayName: 'Hindsight',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.developer-tools',
    artifactName: 'Hindsight-mac-${arch}.${ext}',
    identity: '-',
    hardenedRuntime: false,
    // Ad hoc signatures cannot be timestamped.
    timestamp: 'none',
  },
  dmg: {
    artifactName: 'Hindsight-mac-${arch}.${ext}',
  },

  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'Development',
    executableName: 'hindsight',
    synopsis: 'A tiny programming language with a time machine built in',
    maintainer: 'Ajaypranav25 <ajaypranav25@users.noreply.github.com>',
  },
  appImage: {
    artifactName: 'Hindsight-linux-x86_64.AppImage',
  },
  deb: {
    artifactName: 'Hindsight-linux-amd64.deb',
  },
}

module.exports = config
