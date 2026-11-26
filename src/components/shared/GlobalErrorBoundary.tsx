import { Component, ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Warning24Filled, ArrowClockwise20Regular, Copy20Regular, History20Regular } from "@fluentui/react-icons";
import { useI18nStore } from "@/i18n";
import { Card } from "@/components/ui";
import { WinUIButton } from "@/components/winui/WinUIButton";

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
      const { t } = useI18nStore.getState();
      return (
        <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)] flex items-center justify-center p-6 font-sans select-none">
          <Card className="max-w-xl w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--brand-amber)_14%,transparent)] flex items-center justify-center text-[var(--brand-amber)] shrink-0">
                <Warning24Filled className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{t.layout.globalErrorTitle}</h2>
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">{t.layout.globalErrorDesc}</p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] p-3 font-code text-xs text-[var(--danger)] overflow-x-auto max-h-36 select-text">
              {this.state.error?.toString()}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <WinUIButton variant="standard" onClick={this.handleCopyDiagnostic} icon={<Copy20Regular className="w-4 h-4" />}>
                {this.state.copied ? t.layout.copied : t.layout.exportDiagnostic}
              </WinUIButton>
              <WinUIButton variant="standard" onClick={this.handleUndoCleanups} icon={<History20Regular className="w-4 h-4" />}>
                {t.layout.undoRecent}
              </WinUIButton>
              <WinUIButton variant="primary" onClick={this.handleReload} icon={<ArrowClockwise20Regular className="w-4 h-4" />}>
                {t.layout.reload}
              </WinUIButton>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export default GlobalErrorBoundary;
