import React, { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import {
  DismissCircle20Regular,
  FolderOpen16Regular,
  Document20Regular,
  Sparkle20Filled,
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
    <WinUICard
      className={`p-6 sm:p-8 space-y-5 border-[#0078d4]/30 shadow-lg relative overflow-hidden bg-gradient-to-b from-[#181818] to-[#121212] ${className}`}
    >
      {/* Background ambient glow matching Fluent styling */}
      <div className="absolute top-0 right-0 w-72 h-72 bg-[#0078d4]/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 relative z-10">
        <div className="flex items-center gap-3">
          {/* Animated Heartbeat Indicator */}
          <div className="relative flex items-center justify-center w-8 h-8 rounded-full bg-[#0078d4]/10 border border-[#0078d4]/20 shrink-0">
            <span className="animate-ping absolute inline-flex h-3.5 w-3.5 rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">
                {title || progress.stage || "Disk Engine Active"}
              </h3>
              <span className="px-2 py-0.5 rounded-[4px] bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-[10px] font-bold tracking-wider uppercase font-ibm-mono">
                Running
              </span>
            </div>
            {subtitle && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Big percentage callout */}
        <div className="flex items-baseline gap-1 self-start sm:self-auto font-ibm-mono tabular-nums">
          <span className="text-3xl sm:text-4xl font-extrabold text-[#0078d4] drop-shadow-sm">
            {displayPercent}
          </span>
          <span className="text-base font-semibold text-[var(--text-secondary)]">%</span>
        </div>
      </div>

      {/* Modern Fluent Progress Bar */}
      <div className="space-y-1.5 relative z-10">
        <div className="h-2 w-full bg-black/40 rounded-full overflow-hidden p-[1px] border border-white/[0.06]">
          <div
            className="h-full bg-gradient-to-r from-[#005a9e] via-[#0078d4] to-[#2b88d8] rounded-full transition-all duration-300 ease-out shadow-[0_0_12px_rgba(0,120,212,0.5)]"
            style={{ width: `${displayPercent}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] font-ibm-mono">
          <span>Processing file streams</span>
          <span>{displayPercent} of 100%</span>
        </div>
      </div>

      {/* Live Telemetry Info Panel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 relative z-10">
        {/* Active Path Box */}
        <div className="p-3 bg-black/30 rounded-[4px] border border-[var(--border-subtle)] space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <FolderOpen16Regular className="w-3.5 h-3.5 text-[#0078d4]" />
            <span>Current Path</span>
          </div>
          <div
            className="font-ibm-mono text-xs text-[var(--text-primary)] truncate select-all"
            title={progress.currentPath}
          >
            {truncatedPath || "Evaluating file headers..."}
          </div>
        </div>

        {/* Live Metrics Box */}
        <div className="p-3 bg-black/30 rounded-[4px] border border-[var(--border-subtle)] space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <Document20Regular className="w-3.5 h-3.5 text-indigo-400" />
            <span>Items Scanned</span>
          </div>
          <div className="flex items-center justify-between font-ibm-mono text-xs">
            <span className="text-[var(--text-primary)] font-bold tabular-nums">
              {progress.itemsScanned > 0 ? progress.itemsScanned.toLocaleString() : "Scanning..."}
            </span>
            {progress.bytesFound > 0 && (
              <span className="text-emerald-400 font-semibold tabular-nums">
                {formatBytes(progress.bytesFound)} found
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Footer Actions */}
      {showCancel && (
        <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)] relative z-10">
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <Sparkle20Filled className="w-3.5 h-3.5 text-[#0078d4]" />
            <span>High-speed kernel traversal running</span>
          </div>

          <WinUIButton
            variant="danger"
            onClick={handleDefaultCancel}
            icon={<DismissCircle20Regular className="w-3.5 h-3.5" />}
          >
            Cancel Scan
          </WinUIButton>
        </div>
      )}
    </WinUICard>
  );
};
