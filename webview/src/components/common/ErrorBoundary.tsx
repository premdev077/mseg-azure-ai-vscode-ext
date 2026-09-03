import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logger } from '../../services/logger';
import { ErrorState } from './States';

interface Props {
  /** Named so a report says which panel failed, not just "something". */
  region: string;
  children: ReactNode;
}

interface State {
  error?: Error;
}

/**
 * Isolates a crash to one region.
 *
 * A thrown render in the agent panel should not take the composer with it —
 * the user must still be able to stop the run and read what happened.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error('A panel failed to render', {
      region: this.props.region,
      message: error.message,
      componentStack: info.componentStack
    });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <ErrorState
        message={`The ${this.props.region} could not be displayed. The run itself is unaffected.`}
        retryLabel="Reload this panel"
        onRetry={() => this.setState({})}
      />
    );
  }
}
