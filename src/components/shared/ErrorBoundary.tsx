import { Component, ErrorInfo, ReactNode } from "react";
import {
  Warning20Filled,
  ArrowClockwise20Regular,
  Home20Regular,
  DocumentText20Regular,
} from "@fluentui/react-icons";

interface Props {
  children: ReactNode;
  fallbackTab?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    console.error("FreeMyDisk Uncaught Runtime Exception:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none font-sans">
          <div className="max-w-xl w-full fluent-mica-card border border-rose-500/40 rounded-2xl p-8 shadow-2xl backdrop-blur-xl relative overflow-hidden">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0 shadow-lg shadow-rose-500/10">
                <Warning20Filled className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white tracking-tight">
                    Subsystem Anomaly Detected
                  </h2>
                  <span className="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] font-ibm-mono text-rose-300">
                    CRASH_GUARD_ACTIVE
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  An unexpected exception was caught by FreeMyDisk safety barrier. Your filesystem was left untouched.
                </p>
              </div>
            </div>

            {/* Error detail box */}
            <div className="bg-slate-950/80 border border-white/[0.08] rounded-xl p-4 mb-6 font-ibm-mono text-xs">
              <div className="flex items-center gap-2 text-slate-400 mb-2 border-b border-white/[0.06] pb-2 font-sans">
                <DocumentText20Regular className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-[11px]">Exception Traceback</span>
              </div>
              <p className="text-rose-400 font-semibold break-words">
                {this.state.error?.name}: {this.state.error?.message || "Unknown error"}
              </p>
              {this.state.errorInfo?.componentStack && (
                <pre className="mt-2 text-[10px] text-slate-500 max-h-36 overflow-y-auto leading-relaxed scrollbar-thin">
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-200 text-xs font-medium flex items-center gap-2 border border-white/[0.08] transition-colors cursor-pointer"
              >
                <Home20Regular className="w-3.5 h-3.5" />
                Recover to Dashboard
              </button>
              <button
                onClick={this.handleReload}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-lg shadow-blue-600/20 cursor-pointer"
              >
                <ArrowClockwise20Regular className="w-3.5 h-3.5" />
                Restart Engine
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
