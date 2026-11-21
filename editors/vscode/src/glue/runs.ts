/**
 * The last run of each open .sight document: scheduled after a save, run now for a command,
 * aborted when a newer run starts or the document closes. Each result remembers the document
 * version it ran, so lenses and commands never use a run of text the document no longer holds.
 */
import * as vscode from 'vscode'
import { type Analysis, analyze, type Problem } from '../analysis'
import { type AbortFlag, RunScheduler } from '../run-scheduler'
import { RUN_DELAY_MS, stepBudget } from '../view'

export interface RunResult {
  /** The document version the run recorded. */
  readonly version: number
  readonly analysis: Exclude<Analysis, { kind: 'aborted' }>
}

interface JobResult {
  readonly version: number
  readonly analysis: Analysis
}

const key = (document: vscode.TextDocument) => document.uri.toString()

function toDiagnostic(problem: Problem): vscode.Diagnostic {
  const range = new vscode.Range(
    problem.start.line - 1,
    problem.start.column - 1,
    problem.end.line - 1,
    problem.end.column - 1,
  )
  const severity =
    problem.severity === 'error'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning
  const diagnostic = new vscode.Diagnostic(range, problem.message, severity)
  diagnostic.source = 'hindsight'
  diagnostic.code = problem.code
  return diagnostic
}

export class Runs implements vscode.Disposable {
  private readonly results = new Map<string, RunResult>()
  private readonly scheduler = new RunScheduler({
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  private readonly changed = new vscode.EventEmitter<vscode.Uri>()
  /** Fires when a document has a new result. */
  readonly onDidChange = this.changed.event

  constructor(
    private readonly diagnostics: vscode.DiagnosticCollection,
    private readonly log: (line: string) => void,
  ) {}

  /** The last result of `document` when it ran the text the document holds now, else null. */
  current(document: vscode.TextDocument): RunResult | null {
    const result = this.results.get(key(document))
    return result !== undefined && result.version === document.version ? result : null
  }

  /** Runs `document` after a short pause; saves in a burst make one run. */
  schedule(document: vscode.TextDocument): void {
    this.scheduler.schedule(
      key(document),
      RUN_DELAY_MS,
      (signal) => this.job(document, signal),
      (result) => {
        this.store(document, result)
      },
      (error) => this.fail(document, error),
    )
  }

  /** Runs `document` now; null when a newer run superseded this one or the run failed. */
  async runNow(document: vscode.TextDocument): Promise<RunResult | null> {
    try {
      const outcome = await this.scheduler.run(key(document), (signal) =>
        this.job(document, signal),
      )
      return outcome === null ? null : this.store(document, outcome.value)
    } catch (error) {
      this.fail(document, error)
      return null
    }
  }

  /** The current result, running the document first when it changed since its last run. */
  fresh(document: vscode.TextDocument): Promise<RunResult | null> {
    const result = this.current(document)
    return result === null ? this.runNow(document) : Promise.resolve(result)
  }

  /** Drops everything about a closed document and stops its runs. */
  forget(document: vscode.TextDocument): void {
    this.scheduler.cancel(key(document))
    this.results.delete(key(document))
    this.diagnostics.delete(document.uri)
  }

  dispose(): void {
    this.scheduler.dispose()
    this.changed.dispose()
  }

  private async job(document: vscode.TextDocument, signal: AbortFlag): Promise<JobResult> {
    // The version and the text are read together, before the first await.
    const version = document.version
    const settings = vscode.workspace.getConfiguration('hindsight', document.uri)
    const maxSteps = stepBudget(settings.get('maxSteps'))
    return { version, analysis: await analyze(document.getText(), { maxSteps, signal }) }
  }

  private store(document: vscode.TextDocument, result: JobResult): RunResult | null {
    const { analysis } = result
    if (analysis.kind === 'aborted' || document.isClosed) return null
    const stored: RunResult = { version: result.version, analysis }
    this.results.set(key(document), stored)
    this.diagnostics.set(document.uri, analysis.problems.map(toDiagnostic))
    this.changed.fire(document.uri)
    return stored
  }

  private fail(document: vscode.TextDocument, error: unknown): void {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    this.log(`[${vscode.workspace.asRelativePath(document.uri)}] internal error: ${message}`)
  }
}
