import React, { Component } from "react";
import { cn } from "../../lib/utils";

type LazyLoadBoundaryProps = {
  children: React.ReactNode;
  className?: string;
  fallback?: React.ReactNode;
  name?: string;
  resetKey?: React.Key | null;
};

type LazyLoadBoundaryState = {
  error: Error | null;
  retryKey: number;
};

export class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, LazyLoadBoundaryState> {
  declare props: Readonly<LazyLoadBoundaryProps>;
  declare setState: React.Component<LazyLoadBoundaryProps, LazyLoadBoundaryState>["setState"];
  state: LazyLoadBoundaryState = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<LazyLoadBoundaryState> {
    return { error };
  }

  componentDidUpdate(prevProps: LazyLoadBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private retry = () => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload();
      return;
    }
    this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }));
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      const label = this.props.name || "This area";
      return (
        <div
          className={cn(
            "flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground",
            this.props.className,
          )}
          role="alert"
        >
          <div className="font-medium text-foreground">{label} could not load.</div>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            onClick={this.retry}
          >
            Reload
          </button>
        </div>
      );
    }

    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}
