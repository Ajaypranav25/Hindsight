# Hindsight for VS Code

The [Hindsight](https://github.com/Ajaypranav25/Hindsight) language (`.sight` files) in VS Code,
with the time-travel debugger's answers right in the editor. Every time you save, the extension
records the program on Hindsight's VM (the same deterministic VM as the studio and the CLI) and
shows what the run did:

- **Syntax highlighting** for keywords, the `requires` / `ensures` contract keywords after a
  function's parameter list, strings with `{expr}` interpolation, numbers, comments and builtins.
- **Problems**: compile errors and the runtime error the run stopped on, with hints.
- **Code lenses**: above every `fn` declaration, how many times the last run called it; above code
  the last run never reached, **never ran — why not?** Click it for the explanation.
- **Hindsight: Why Didn't This Line Run?** explains, after the cursor's line, why it did not run
  ("Line 12 never ran because at step 41, `total > 80` was false (total was 75, set at step 30 on
  line 9).").
- **Hindsight: Lines That Led to the Crash** dims every line outside the backward slice of the
  runtime error, so only the lines that could have caused it stand out.
- **Hindsight: Run File** prints the output and how the run ended to the Hindsight output channel.
- **Hindsight: Open in Studio** opens the program in the Hindsight desktop app with the pen on the
  first step of the cursor's line. It needs the app: download it for Windows, macOS or Linux from
  the [latest release](https://github.com/Ajaypranav25/Hindsight/releases/latest). The link
  carries the program, so it holds programs whose link fits in 30,000 characters; open longer ones
  in the app with **File > Open**. To use a studio you run yourself instead (`npm run dev` in a
  checkout of the repository), set `hindsight.studioUrl` to its address.
- **Hindsight: Clear Highlights** removes the explanation and the dimming (editing does too).

Runs happen in the extension host in short slices, so the editor stays responsive; a save while a
run is still recording aborts it and starts over.

## Settings

| Setting               | Default            | What it does                                                                                       |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `hindsight.maxSteps`  | 2,000,000          | Step budget per run (one step = one instruction)                                                   |
| `hindsight.runOnSave` | `true`             | Record on open and on save                                                                         |
| `hindsight.codeLens`  | `true`             | Show call counts and never-ran lenses                                                              |
| `hindsight.studioUrl` | `hindsight://open` | Where "Open in Studio" opens programs: the desktop app, or the http(s) address of a studio you run |

## Install

Search for **Hindsight** in the Extensions view (publisher `ajaypranav25`), or run:

```sh
code --install-extension ajaypranav25.hindsight-vscode
```

Open any `.sight` file and save it; the run's results appear in the editor. There is nothing else
to install: the extension carries Hindsight's VM with it.

### From a .vsix

To build the package yourself from a checkout of the repository:

```sh
cd editors/vscode
npm install
npm run package            # writes hindsight-vscode-<version>.vsix
code --install-extension hindsight-vscode-*.vsix
```

Or, in VS Code, run **Extensions: Install from VSIX...** and pick the file.

## Develop

```sh
cd editors/vscode
npm install
npm run build              # bundles src/glue/extension.ts and ../../src/core into dist/extension.js
npm run typecheck          # the whole extension against the VS Code API
npm run smoke              # loads dist/extension.js against a fake vscode module and drives it
```

To try it in an **Extension Development Host**, open `editors/vscode` in VS Code, run
`npm run build`, then press F5 (or run `code --extensionDevelopmentPath=<repo>/editors/vscode
<repo>/examples`) and open any `.sight` file in the new window. Rebuild and reload the window
(**Developer: Reload Window**) after changing the code.

The logic that decides what to show lives in vscode-free modules (`src/analysis.ts`, `src/view.ts`,
`src/run-scheduler.ts`, `src/studio-link.ts`) whose tests run with the repository's
`npm test`; `src/glue/` only turns their results into VS Code objects.
