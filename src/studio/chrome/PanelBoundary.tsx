import { Component, type ErrorInfo, type ReactNode } from 'react'

interface BoundaryProps {
  readonly name: string
  readonly children: ReactNode
}

interface BoundaryState {
  readonly error: Error | null
}

/**
 * Keeps one failing area from blanking the whole studio. (Error boundaries can only be written as
 * class components; this is the one class in the studio.)
 */
export class PanelBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.name} failed to render`, error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ch-boundary" role="alert">
        <p>
          {this.props.name} stopped working: {error.message}
        </p>
        <button type="button" className="ch-button ch-button-small" onClick={this.retry}>
          Try again
        </button>
      </div>
    )
  }

  private readonly retry = () => this.setState({ error: null })
}
