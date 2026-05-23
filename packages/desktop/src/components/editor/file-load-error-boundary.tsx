import { Component } from "react";
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileLoadErrorBoundaryProps {
  filePath: string;
  onRetry: () => Promise<void>;
  children: ReactNode;
}

interface FileLoadErrorBoundaryState {
  error: Error | null;
  retrying: boolean;
}

export class FileLoadErrorBoundary extends Component<
  FileLoadErrorBoundaryProps,
  FileLoadErrorBoundaryState
> {
  constructor(props: FileLoadErrorBoundaryProps) {
    super(props);
    this.state = { error: null, retrying: false };
  }

  static getDerivedStateFromError(error: Error): FileLoadErrorBoundaryState {
    return { error, retrying: false };
  }

  componentDidCatch(error: Error) {
    console.error("[FileLoadErrorBoundary] Failed to load file:", error);
  }

  componentDidUpdate(prevProps: FileLoadErrorBoundaryProps) {
    if (prevProps.filePath !== this.props.filePath && this.state.error) {
      this.setState({ error: null, retrying: false });
    }
  }

  private handleRetry = async () => {
    this.setState({ retrying: true });
    try {
      await this.props.onRetry();
      this.setState({ error: null, retrying: false });
    } catch (error) {
      this.setState({
        error:
          error instanceof Error ? error : new Error("Failed to load file"),
        retrying: false,
      });
    }
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="size-8 text-destructive" />
        <p className="text-sm text-muted-foreground">
          {this.state.error.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={this.handleRetry}
          disabled={this.state.retrying}
        >
          {this.state.retrying ? "Retrying..." : "Retry"}
        </Button>
      </div>
    );
  }
}
