import React, { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Card, Badge, ProgressBar } from "@/components/ui";
import { useI18nStore } from "@/i18n";
import {
  DismissCircle20Regular,
  FolderOpen16Regular,
  Document20Regular,
} from "@fluentui/react-icons";

export interface LiveScanProgressWidgetProps {
  scanType: string;
  title?: string;
  subtitle?: string;
  onCancel?: () => void;
  showCancel?: boolean;
  className?: string;
}

export const LiveScanProgressWidget: React.FC<LiveScanProgressWidgetProps> = ({
  scanType,
  title,
  subtitle,
  onCancel,
  showCancel = true,
  className = "",
}) => {
  const { t } = useI18nStore();
  const { initProgressListener } = useScanProgressStore();
  const progress = useScanProgress(scanType);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initProgressListener().then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [initProgressListener]);

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  // Middle truncate long paths nicely for WinUI display
  const truncatedPath = useMemo(() => {
    const p = progress.currentPath;
    if (!p) return "";
    const maxLen = 64;
    if (p.length <= maxLen) return p;
    const partLen = Math.floor((maxLen - 3) / 2);
    return `${p.substring(0, partLen)}...${p.substring(p.length - partLen)}`;
  }, [progress.currentPath]);

  const handleDefaultCancel = async () => {
    if (onCancel) {
      onCancel();
    } else {
      try {
        await invoke<boolean>("cancel_active_scan", { kind: scanType });
      } catch (e) {
        console.error("Failed to cancel active scan:", e);
      }
    }
  };

  // Clamp percentage between 1 and 100 (never stuck on 0 during active scan)
  const displayPercent = Math.max(1, Math.min(100, progress.percent || 1));

  return (
    <Card className={`space-y-4 ${className}`}>
      {/* Header: live indicator, title, percentage */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="relative flex w-2.5 h-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--accent)]" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                {title || progress.stage || t.layout.scanDefaultTitle}
              </h3>
              <Badge tone="accent">{t.layout.scanRunning}</Badge>
            </div>
            {subtitle && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{subtitle}</p>}
          </div>
        </div>
        <div className="text-2xl font-semibold font-ibm-mono text-[var(--text-primary)] shrink-0">
          {displayPercent}
          <span className="text-sm text-[var(--text-secondary)] ml-0.5">%</span>
        </div>
      </div>

      <ProgressBar value={displayPercent} />

      {/* Live details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-md bg-[var(--fill-subtle)] px-3 py-2 space-y-0.5 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <FolderOpen16Regular className="w-3.5 h-3.5" />
            <span>{t.layout.scanCurrentPath}</span>
          </div>
          <div className="font-code text-xs text-[var(--text-primary)] truncate select-all" title={progress.currentPath}>
            {truncatedPath || t.layout.scanStarting}
          </div>
        </div>

        <div className="rounded-md bg-[var(--fill-subtle)] px-3 py-2 space-y-0.5 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Document20Regular className="w-3.5 h-3.5" />
            <span>{t.layout.scanItems}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs font-ibm-mono">
            <span className="text-[var(--text-primary)] font-semibold">
              {progress.itemsScanned > 0 ? progress.itemsScanned.toLocaleString() : t.common.scanning}
            </span>
            {progress.bytesFound > 0 && (
              <span className="text-[var(--text-secondary)]">
                {t.layout.scanFound.replace("{size}", formatBytes(progress.bytesFound))}
              </span>
            )}
          </div>
        </div>
      </div>

      {showCancel && (
        <div className="flex justify-end">
          <WinUIButton
            variant="standard"
            onClick={handleDefaultCancel}
            icon={<DismissCircle20Regular className="w-4 h-4 text-[var(--danger)]" />}
          >
            {t.common.cancelScan}
          </WinUIButton>
        </div>
      )}
    </Card>
  );
};
