import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { DebugPanel } from "./debug-panel";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
}

interface WorkspaceErrorBoundaryState {
  error: { message: string; stack?: string } | null;
}

export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  constructor(props: WorkspaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return {
      error: {
        message: error.message,
        stack: error.stack,
      },
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[WorkspaceErrorBoundary] Caught error:", error);
    if (errorInfo.componentStack) {
      console.error(
        "[WorkspaceErrorBoundary] Component stack:",
        errorInfo.componentStack,
      );
    }
  }

  render() {
    if (this.state.error) {
      return <DebugPanel forceOpen error={this.state.error} />;
    }

    return this.props.children;
  }
}
