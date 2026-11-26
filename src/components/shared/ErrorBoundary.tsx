import { Component, ErrorInfo, ReactNode } from "react";
import {
  Warning20Filled,
  ArrowClockwise20Regular,
  Home20Regular,
  DocumentText20Regular,
} from "@fluentui/react-icons";
import { useI18nStore } from "@/i18n";
import { Card } from "@/components/ui";
import { WinUIButton } from "@/components/winui/WinUIButton";

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
      const { t } = useI18nStore.getState();
      return (
        <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)] flex items-center justify-center p-6 select-none font-sans">
          <Card className="max-w-xl w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Warning20Filled className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{t.layout.errorTitle}</h2>
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">{t.layout.errorDesc}</p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <DocumentText20Regular className="w-3.5 h-3.5" />
                <span>{t.layout.errorDetails}</span>
              </div>
              <p className="font-code text-xs text-[var(--danger)] break-words select-text">
                {this.state.error?.name}: {this.state.error?.message || "Unknown error"}
              </p>
              {this.state.errorInfo?.componentStack && (
                <pre className="font-code text-xs text-[var(--text-muted)] max-h-36 overflow-y-auto leading-relaxed select-text">
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </div>

            <div className="flex items-center gap-2 justify-end">
              <WinUIButton variant="standard" onClick={this.handleReset} icon={<Home20Regular className="w-4 h-4" />}>
                {t.layout.goToDashboard}
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

export default ErrorBoundary;
