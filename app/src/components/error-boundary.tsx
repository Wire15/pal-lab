// Crash-safety boundary around the active view outlet. A render error in any one
// view (Solver, Pal-dex, IV Lab, map, …) is caught here and shown as a friendly
// recovery panel instead of white-screening the whole app — the nav shell stays
// mounted and usable. Background/async failures (watcher reload, solve-event
// decode) are handled separately as non-blocking toasts in state.tsx; this
// boundary only catches synchronous render/lifecycle errors, which React does
// not surface to window.onerror in a way a toast could recover from.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Return to a known-good view (Save Inspector). Called before the boundary
   * clears its own error state, so the child tree changes on recovery. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

/** React error boundary. Must be a class component — hooks cannot catch. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack for the copy-details payload; also log so it lands
    // in the webview console for post-mortem.
    this.setState({ info });
    console.error("View crashed:", error, info.componentStack);
  }

  private details(): string {
    const { error, info } = this.state;
    return [
      `Pal Lab — view crash report`,
      `message: ${error?.message ?? "(unknown)"}`,
      ``,
      `stack:`,
      error?.stack ?? "(no stack)",
      ``,
      `component stack:`,
      info?.componentStack?.trim() ?? "(none)",
    ].join("\n");
  }

  private copy = () => {
    navigator.clipboard
      ?.writeText(this.details())
      .then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 1400);
      })
      .catch(() => {
        // Clipboard blocked — non-fatal, the details are still on screen.
      });
  };

  private back = () => {
    this.props.onReset?.();
    this.setState({ error: null, info: null, copied: false });
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-abyss p-6 text-ink">
        <div className="w-full max-w-lg overflow-hidden rounded-lg border border-bad/40 bg-panel">
          <div className="border-b border-line bg-bad/10 px-5 py-4">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-bad">
              Something broke
            </div>
            <h2 className="mt-0.5 font-display text-lg font-bold tracking-wide text-ink">
              This view hit an error
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
              The rest of Pal Lab is still running — your save is untouched
              (nothing is ever written). Head back to the Save Inspector, or
              reload the app.
            </p>
          </div>

          <div className="px-5 py-4">
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
              Error
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-abyss px-3 py-2 font-mono text-[11px] leading-relaxed text-bad">
              {error.message || String(error)}
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <button
              onClick={this.copy}
              className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              {copied ? "Copied\u2713" : "Copy details"}
            </button>
            <button
              onClick={this.back}
              className="rounded-md border border-line bg-raised px-3 py-1.5 text-[13px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
            >
              Back to Save Inspector
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-amber px-4 py-1.5 text-[13px] font-semibold text-abyss transition-colors hover:bg-amber-bright"
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
