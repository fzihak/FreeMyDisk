import { Component, ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Warning24Filled, ArrowClockwise20Regular, Copy20Regular, History20Regular } from "@fluentui/react-icons";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  copied: boolean;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    copied: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
      copied: false,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    // Telemetry to Rust backend
    invoke("log_frontend_exception", {
      error: error.toString(),
      stack: errorInfo.componentStack,
    }).catch(() => {});
  }

  private handleReload = () => {
    // Clear potentially corrupted Zustand ephemeral state and reload
    window.location.reload();
  };

  private handleUndoCleanups = () => {
    try {
      localStorage.removeItem("fmd-active-tab");
      window.location.hash = "#/history";
      window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  private handleCopyDiagnostic = () => {
    const rawDiagnostic = `FreeMyDisk Frontend Crash Report\nError: ${this.state.error?.toString()}\nStack:\n${this.state.errorInfo?.componentStack || this.state.error?.stack || "No stack"}`;
    // Privacy redaction for username
    const sanitized = rawDiagnostic.replace(/([a-zA-Z]:\\[Uu]sers\\)[^\\]+/g, "$1{USER}");
    navigator.clipboard.writeText(sanitized).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2500);
    });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans select-none">
          <div className="max-w-xl w-full bg-slate-900 border border-amber-500/30 rounded-2xl p-6 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                <Warning24Filled className="text-amber-400 w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-100">FreeMyDisk Interface Interrupted</h2>
                <p className="text-xs text-slate-400">An unexpected interface error occurred. Your system files and session data remain safe.</p>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 mb-5 font-mono text-xs text-amber-200/90 overflow-x-auto max-h-36">
              {this.state.error?.toString()}
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={this.handleReload}
                className="flex-1 min-w-[140px] flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer shadow-sm"
              >
                <ArrowClockwise20Regular className="w-4 h-4" />
                Reload Interface
              </button>

              <button
                onClick={this.handleUndoCleanups}
                className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-200 text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                <History20Regular className="w-4 h-4" />
                Undo Recent Cleanups
              </button>

              <button
                onClick={this.handleCopyDiagnostic}
                className="flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs py-2.5 px-4 rounded-xl transition-colors cursor-pointer"
              >
                <Copy20Regular className="w-4 h-4" />
                {this.state.copied ? "Copied" : "Export Diagnostic"}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default GlobalErrorBoundary;
