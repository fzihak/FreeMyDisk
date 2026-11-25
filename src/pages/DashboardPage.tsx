import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NavTab } from "@/components/layout/Sidebar";
import { useSettingsStore } from "@/stores/settings-store";
import { useI18nStore } from "@/i18n";
import { toast } from "@/stores/toast-store";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { useCleanupScanStore } from "@/stores/cleanup-scan-store";
import type { RuleScanSummary } from "@/types/cleanup";
import { describeDisposal } from "@/utils/disposal";
import {
  Storage24Filled,
  Delete20Filled,
  Sparkle20Filled,
  Flash20Filled,
  ArrowClockwise20Regular,
  ChevronRight16Regular,
  CheckmarkCircle24Filled,
  Apps20Filled,
  DocumentFolder20Filled,
  DocumentCopy20Filled,
  Shield20Filled,
  Checkmark16Filled,
  Wrench20Filled,
} from "@fluentui/react-icons";
import { WinUICard, WinUISettingRow } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";

interface StorageVolumeInfo {
  mount_point: string;
  volume_name: string;
  total_bytes: number;
  available_bytes: number;
  file_system: string;
  is_removable: boolean;
}

interface StartupItem {
  id: string;
  name: string;
  enabled: boolean;
  impact: string;
  is_critical: boolean;
}

interface SystemVitals {
  total_ram_bytes: number;
  available_ram_bytes: number;
  used_ram_bytes: number;
  memory_load_percent: number;
  os_name: string;
  computer_name: string;
  cpu_cores: number;
}

interface DisposalSummary {
  session_id?: string;
  total_requested_items?: number;
  successful_items?: number;
  failed_items?: number;
  total_freed_bytes: number;
  recycled_bytes?: number;
}

interface EmergencyRescueResult {
  total_bytes_reclaimed: number;
  hibernation_disabled: boolean;
  recycle_bin_emptied: boolean;
  temp_cleaned_bytes: number;
  wsl_shutdown: boolean;
  actions_performed: string[];
}

interface RecycleBinStatus {
  total_bytes: number;
  item_count: number;
}

interface DashboardPageProps {
  onNavigate: (tab: NavTab) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { t } = useI18nStore();
  const [volumes, setVolumes] = useState<StorageVolumeInfo[]>([]);
  const [selectedVolumeIdx, setSelectedVolumeIdx] = useState<number>(0);
  const [ruleSummaries, setRuleSummaries] = useState<RuleScanSummary[]>([]);
  const [startupItems, setStartupItems] = useState<StartupItem[]>([]);
  const [vitals, setVitals] = useState<SystemVitals | null>(null);
  const [recycleBin, setRecycleBin] = useState<RecycleBinStatus | null>(null);
  const [emptyingBin, setEmptyingBin] = useState(false);

  const [emergencyModalOpen, setEmergencyModalOpen] = useState(false);
  const [rescuing, setRescuing] = useState(false);
  const [rescueResult, setRescueResult] = useState<EmergencyRescueResult | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [scanStage, setScanStage] = useState<string>("Ready to scan");
  const [scanCompleted, setScanCompleted] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [reclaimedBytes, setReclaimedBytes] = useState<number | null>(null);
  const [boostingRam, setBoostingRam] = useState(false);

  const { alwaysTrashOverride } = useSettingsStore();

  const handleBoostRam = async () => {
    setBoostingRam(true);
    try {
      await invoke("trim_process_memory");
      const vit = await invoke<SystemVitals>("get_system_vitals").catch(() => null);
      if (vit) setVitals(vit);
      toast.success(t.dashboard.ramOptimized, t.dashboard.ramOptimizedDesc);
    } catch (e) {
      console.warn("Failed to boost RAM:", e);
    } finally {
      setBoostingRam(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const loadInitialData = async () => {
    try {
      const [vols, vit, startups, rbin] = await Promise.all([
        invoke<StorageVolumeInfo[]>("get_storage_volumes").catch(() => []),
        invoke<SystemVitals>("get_system_vitals").catch(() => null),
        invoke<StartupItem[]>("get_startup_items").catch(() => []),
        invoke<RecycleBinStatus>("get_recycle_bin_status").catch(() => null),
      ]);

      if (vols.length > 0) setVolumes(vols);
      if (vit) setVitals(vit);
      if (startups) setStartupItems(startups);
      if (rbin) setRecycleBin(rbin);
    } catch (e) {
      console.error("Failed to load dashboard data:", e);
    }
  };

  useEffect(() => {
    loadInitialData();
    const cached = useCleanupScanStore.getState().fresh();
    if (cached) {
      setRuleSummaries(cached);
      setScanCompleted(true);
    } else {
      handleStartScan();
    }
  }, []);

  // Undefined until the drive list has loaded; nothing is shown in its place.
  const currentVolume: StorageVolumeInfo | undefined = volumes[selectedVolumeIdx];
  const volumeTotalBytes = currentVolume?.total_bytes ?? 0;
  const volumeUsedBytes = currentVolume
    ? Math.max(0, currentVolume.total_bytes - currentVolume.available_bytes)
    : 0;
  const volumePercentUsed = volumeTotalBytes > 0
    ? Math.round((volumeUsedBytes / volumeTotalBytes) * 100)
    : 0;

  const totalCleanableBytes = useMemo(() => {
    return ruleSummaries.reduce((acc, r) => acc + r.total_bytes, 0);
  }, [ruleSummaries]);

  const cleanupProgress = useScanProgress("cleanup");
  const { initProgressListener } = useScanProgressStore();

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initProgressListener().then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [initProgressListener]);

  useEffect(() => {
    if (scanning && cleanupProgress) {
      if (cleanupProgress.percent > 0) {
        setScanProgress(cleanupProgress.percent);
      }
      if (cleanupProgress.stage) {
        setScanStage(cleanupProgress.stage);
      }
    }
  }, [scanning, cleanupProgress]);

  const handleStartScan = async () => {
    setScanning(true);
    setScanCompleted(false);
    setReclaimedBytes(null);
    setScanProgress(1);
    setScanStage(t.dashboard.scanningCaches);

    try {
      const summaries = await useCleanupScanStore.getState().scan();
      setRuleSummaries(summaries);
      setScanProgress(100);
      setScanStage(t.dashboard.scanCompletedStage);
      setScanCompleted(true);
    } catch (e) {
      console.error("Quick scan failed:", e);
      setScanStage(t.dashboard.scanInterruptedStage);
    } finally {
      setScanning(false);
    }
  };

  const handleInstantClean = async () => {
    if (totalCleanableBytes === 0) return;
    setCleaning(true);

    const cleanableRules = ruleSummaries.filter((r) => r.total_bytes > 0 || r.total_items > 0);
    const ruleIdsToClean = cleanableRules.length > 0
      ? cleanableRules.map((r) => r.rule_id)
      : ruleSummaries.map((r) => r.rule_id);

    try {
      const summary = await invoke<DisposalSummary>("execute_cleanup_rules", {
        plan: {
          rule_ids: ruleIdsToClean,
          dry_run: false,
          force_permanent: !alwaysTrashOverride,
          close_locking_apps: true,
        },
      });

      setReclaimedBytes(summary.total_freed_bytes + (summary.recycled_bytes ?? 0));
      setRuleSummaries([]);
      loadInitialData();
      toast.success(t.cleanup.cleanComplete, describeDisposal(summary, t, formatBytes));
    } catch (e) {
      console.error("Instant clean failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setCleaning(false);
    }
  };


  const handleEmergencyRescue = async () => {
    setRescuing(true);
    try {
      const result = await invoke<EmergencyRescueResult>("execute_emergency_rescue");
      setRescueResult(result);
      loadInitialData();
      toast.success(
        t.dashboard.emergencySuccess,
        `${formatBytes(result.total_bytes_reclaimed)} ${t.dashboard.reclaimedNotice}`
      );
    } catch (e) {
      console.error("Emergency rescue failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setRescuing(false);
    }
  };

  const handleEmptyRecycleBin = async () => {
    setEmptyingBin(true);
    try {
      const reclaimed = await invoke<number>("empty_recycle_bin");
      toast.success(
        t.dashboard.rescueActionTrash,
        `${formatBytes(reclaimed)} ${t.dashboard.reclaimedNotice}`
      );
      setRecycleBin({ total_bytes: 0, item_count: 0 });
      loadInitialData();
    } catch (e) {
      toast.error(t.common.error, String(e));
    } finally {
      setEmptyingBin(false);
    }
  };

  const highImpactStartups = useMemo(() => {
    return startupItems.filter((item) => item.enabled && item.impact.toLowerCase() === "high").length;
  }, [startupItems]);

  const isDiskCritical = useMemo(() => {
    return volumes.some((v) => {
      const freePct = v.total_bytes > 0 ? (v.available_bytes / v.total_bytes) * 100 : 100;
      return freePct < 15;
    });
  }, [volumes]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)]">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
            {t.dashboard.title}
          </h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {t.dashboard.subtitle}
          </p>
        </div>

        {vitals && (
          <div className="flex items-center gap-2 text-xs bg-white/[0.04] border border-[var(--border-subtle)] px-3 py-1.5 rounded-[4px] shrink-0 text-[var(--text-secondary)]">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-medium text-[var(--text-primary)]">{vitals.os_name}</span>
            <span className="text-[var(--text-muted)]">|</span>
            <span className="font-ibm-mono">{vitals.cpu_cores} cores</span>
            <span className="text-[var(--text-muted)]">|</span>
            <span>RAM: <strong className="font-ibm-mono text-[var(--text-primary)]">{vitals.memory_load_percent}%</strong></span>
          </div>
        )}
      </div>

      {/* Microsoft PC Manager Signature Health / Quick Boost Hero Card */}
      <WinUICard className="p-5">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          {/* Left metrics */}
          <div className="flex flex-wrap items-center gap-8 flex-1">
            {/* Cleanable temporary files metric */}
            <div className="space-y-1">
              <span className="text-xs text-[var(--text-secondary)] font-normal">
                {t.dashboard.quickScanTitle}
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold font-ibm-mono text-[var(--text-primary)] tabular-nums">
                  {reclaimedBytes !== null
                    ? "0 B"
                    : scanCompleted
                    ? formatBytes(totalCleanableBytes)
                    : "Ready"}
                </span>
                {scanCompleted && totalCleanableBytes > 0 && (
                  <span className="text-xs font-medium text-emerald-400 font-ibm-mono">
                    reclaimable
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                {scanCompleted
                  ? `${ruleSummaries.length} categories inspected`
                  : "Temporary files, cache & logs"}
              </p>
            </div>

            <div className="hidden sm:block h-10 w-px bg-[var(--border-divider)]" />

            {/* RAM Load metric */}
            {vitals && (
              <div className="space-y-1">
                <span className="text-xs text-[var(--text-secondary)] font-normal">
                  RAM Memory Usage
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold font-ibm-mono text-[var(--text-primary)] tabular-nums">
                    {vitals.memory_load_percent}%
                  </span>
                  <button
                    onClick={handleBoostRam}
                    disabled={boostingRam}
                    className="text-xs font-semibold text-[#0078d4] hover:text-[#4cc2ff] underline cursor-pointer disabled:opacity-50 transition-colors"
                  >
                    {boostingRam ? "Boosting..." : "Boost"}
                  </button>
                  <span className="text-xs font-medium text-[var(--text-muted)] font-ibm-mono">
                    {((vitals.used_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(1)} GB /{" "}
                    {((vitals.total_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(0)} GB
                  </span>
                </div>
                <div className="w-32 bg-black/20 h-1 rounded-full overflow-hidden">
                  <div
                    style={{ width: `${vitals.memory_load_percent}%` }}
                    className="h-full bg-[#0078d4] rounded-full transition-all duration-500"
                  />
                </div>
              </div>
            )}

            {recycleBin && recycleBin.total_bytes > 0 && (
              <>
                <div className="hidden sm:block h-10 w-px bg-[var(--border-divider)]" />
                <div className="space-y-1">
                  <span className="text-xs text-[var(--text-secondary)] font-normal">
                    Recycle Bin
                  </span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold font-ibm-mono text-[var(--text-primary)] tabular-nums">
                      {formatBytes(recycleBin.total_bytes)}
                    </span>
                    <button
                      onClick={handleEmptyRecycleBin}
                      disabled={emptyingBin}
                      className="text-xs font-semibold text-rose-400 hover:text-rose-300 underline cursor-pointer disabled:opacity-50 transition-colors"
                    >
                      {emptyingBin ? "Emptying..." : "Empty"}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {recycleBin.item_count} items across drives
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Right Action buttons */}
          <div className="shrink-0 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full md:w-auto">
            {scanCompleted && totalCleanableBytes > 0 ? (
              <WinUIButton
                variant="primary"
                size="lg"
                onClick={handleInstantClean}
                disabled={cleaning}
                icon={<Sparkle20Filled className="w-4 h-4" />}
              >
                {cleaning ? t.common.cleaning : t.dashboard.cleanNow}
              </WinUIButton>
            ) : (
              <WinUIButton
                variant="primary"
                size="lg"
                onClick={handleStartScan}
                disabled={scanning}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
              >
                {scanning ? scanStage : t.dashboard.startQuickScan}
              </WinUIButton>
            )}

            {scanCompleted && (
              <WinUIButton
                variant="standard"
                size="lg"
                onClick={handleStartScan}
                disabled={scanning}
              >
                Rescan
              </WinUIButton>
            )}
          </div>
        </div>

        {/* Live scanning progress bar with engine heartbeat */}
        {scanning && (
          <div className="mt-4 pt-3 border-t border-[var(--border-divider)] space-y-2">
            <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-2 truncate mr-3">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                </span>
                <span className="truncate">{scanStage}</span>
              </div>
              <span className="font-ibm-mono font-bold text-[#0078d4] tabular-nums shrink-0">
                {scanProgress}%
              </span>
            </div>
            <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden p-[1px] border border-white/[0.04]">
              <div
                style={{ width: `${Math.max(1, scanProgress)}%` }}
                className="h-full bg-gradient-to-r from-[#005a9e] via-[#0078d4] to-[#2b88d8] rounded-full transition-all duration-200"
              />
            </div>
            {cleanupProgress.currentPath && (
              <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono truncate">
                Active rule: {cleanupProgress.currentPath}
              </div>
            )}
          </div>
        )}
      </WinUICard>

      {/* Windows 11 Storage Sense Bar Card */}
      <WinUICard className="p-5 space-y-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
              <Storage24Filled className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {currentVolume
                    ? `${currentVolume.volume_name || currentVolume.mount_point} (${currentVolume.mount_point})`
                    : t.dashboard.driveSpaceTitle}
                </h2>
                {currentVolume && (
                  <span className="text-[10px] font-ibm-mono px-1.5 py-0.5 rounded-[4px] bg-white/[0.06] text-[var(--text-secondary)]">
                    {currentVolume.file_system}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-secondary)] font-ibm-mono mt-0.5">
                {currentVolume ? (
                  <>
                    <span>{formatBytes(volumeUsedBytes)}</span> / <span>{formatBytes(volumeTotalBytes)}</span> ({volumePercentUsed}%) ·{" "}
                    <strong className="text-emerald-400 font-semibold">
                      {formatBytes(currentVolume.available_bytes)} {t.dashboard.freeSpaceCategory}
                    </strong>
                  </>
                ) : (
                  <span className="inline-block w-48 h-3 rounded bg-white/[0.06] animate-pulse" />
                )}
              </p>
            </div>
          </div>

          {/* Drive selector tabs */}
          {volumes.length > 1 && (
            <div className="flex items-center gap-1 bg-black/20 p-0.5 rounded-[4px] border border-[var(--border-subtle)] self-start sm:self-auto">
              {volumes.map((vol, idx) => (
                <button
                  key={vol.mount_point}
                  onClick={() => setSelectedVolumeIdx(idx)}
                  className={`px-2.5 py-1 text-xs rounded-[3px] font-ibm-mono transition-all cursor-pointer ${
                    selectedVolumeIdx === idx
                      ? "bg-[var(--bg-card)] text-[var(--text-primary)] font-semibold shadow-sm"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {vol.mount_point}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Capacity bar: real used space, the part a scan found cleanable, and free space */}
        <div className="w-full h-3 bg-black/20 rounded-[4px] overflow-hidden flex border border-[var(--border-subtle)]">
          {volumeTotalBytes > 0 && (
            <>
              <div
                style={{ width: `${((volumeUsedBytes - Math.min(totalCleanableBytes, volumeUsedBytes)) / volumeTotalBytes) * 100}%` }}
                title={t.dashboard.usedSpaceCategory}
                className="h-full bg-[#0078d4] transition-all duration-500"
              />
              <div
                style={{ width: `${(Math.min(totalCleanableBytes, volumeUsedBytes) / volumeTotalBytes) * 100}%` }}
                title={t.dashboard.tempFilesCategory}
                className="h-full bg-[#f7630c] transition-all duration-500"
              />
            </>
          )}
        </div>

        {/* Legend Row */}
        <div className="flex flex-wrap items-center gap-5 text-[11px] text-[var(--text-secondary)] pt-1">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[2px] bg-[#0078d4]" />
            <span>{t.dashboard.usedSpaceCategory}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[2px] bg-[#f7630c]" />
            <span>{t.dashboard.tempFilesCategory}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-[2px] bg-white/[0.15]" />
            <span>{t.dashboard.freeSpaceCategory}</span>
          </div>
        </div>
      </WinUICard>

      {/* WinUI 3 Group 1: Storage Cleaners & Intelligence */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">
          Storage Intelligence
        </h3>
        <WinUICard>
          <WinUISettingRow
            icon={<Delete20Filled className="w-4 h-4 text-[#0078d4]" />}
            title={t.nav.cleanup}
            subtitle="Clean temporary system caches, crash dumps, and Windows logs"
            onClick={() => onNavigate("cleanup")}
            action={
              <div className="flex items-center gap-2">
                {totalCleanableBytes > 0 && (
                  <span className="text-[11px] font-ibm-mono font-medium px-2 py-0.5 rounded-[4px] bg-[#0078d4]/10 text-[#4cc2ff] border border-[#0078d4]/20">
                    {formatBytes(totalCleanableBytes)}
                  </span>
                )}
                <ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />
              </div>
            }
          />
          <WinUISettingRow
            icon={<DocumentFolder20Filled className="w-4 h-4 text-[#8764b8]" />}
            title={t.nav.largeFiles}
            subtitle="Identify files taking up significant capacity (> 500 MB)"
            onClick={() => onNavigate("large_files")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
          <WinUISettingRow
            icon={<DocumentCopy20Filled className="w-4 h-4 text-[#00b7c3]" />}
            title={t.nav.duplicates}
            subtitle="Inode-aware SHA-256 duplicate detection with hard-link protection"
            onClick={() => onNavigate("duplicates")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
        </WinUICard>
      </div>

      {/* WinUI 3 Group 2: Protection & System Safety */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">
          Protection & Safety
        </h3>
        <WinUICard>
          <WinUISettingRow
            icon={<Shield20Filled className="w-4 h-4 text-emerald-400" />}
            title={t.nav.privacy}
            subtitle="Purge browser histories, tracking cookies, and session locks"
            onClick={() => onNavigate("privacy")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
          <WinUISettingRow
            icon={<Flash20Filled className="w-4 h-4 text-rose-400" />}
            title={t.dashboard.emergencyBannerTitle}
            subtitle={t.dashboard.emergencyBannerDesc}
            badge={
              <span className={`text-[10px] font-ibm-mono px-2 py-0.2 rounded-[4px] font-semibold uppercase ${
                isDiskCritical
                  ? "bg-rose-600 text-white"
                  : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
              }`}>
                {isDiskCritical ? "CRITICAL DISK SPACE" : "10GB–40GB Rescue"}
              </span>
            }
            action={
              <WinUIButton
                variant="danger"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setRescueResult(null);
                  setEmergencyModalOpen(true);
                }}
              >
                {t.dashboard.emergencyRescueButton}
              </WinUIButton>
            }
          />
        </WinUICard>
      </div>

      {/* WinUI 3 Group 3: Applications & Performance */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">
          Applications & Diagnostics
        </h3>
        <WinUICard>
          <WinUISettingRow
            icon={<Apps20Filled className="w-4 h-4 text-[#0078d4]" />}
            title={t.nav.applications}
            subtitle="Uninstall desktop applications, UWP components, and leftover registry files"
            onClick={() => onNavigate("applications")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
          <WinUISettingRow
            icon={<Flash20Filled className="w-4 h-4 text-amber-400" />}
            title={t.dashboard.startupCard}
            subtitle={t.dashboard.startupDesc}
            badge={
              highImpactStartups > 0 ? (
                <span className="text-[10px] font-ibm-mono font-semibold px-2 py-0.2 rounded-[4px] bg-amber-500/15 text-amber-300 border border-amber-500/20">
                  {highImpactStartups} High Impact
                </span>
              ) : undefined
            }
            onClick={() => onNavigate("startup")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
          <WinUISettingRow
            icon={<Wrench20Filled className="w-4 h-4 text-cyan-400" />}
            title={t.nav.maintenance}
            subtitle="Perform DISM component repair, SFC scan, and icon/font cache rebuilds"
            onClick={() => onNavigate("maintenance")}
            action={<ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)]" />}
          />
        </WinUICard>
      </div>

      {/* Emergency Rescue Modal - WinUI 3 ContentDialog */}
      {emergencyModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg max-w-lg w-full p-6 space-y-5 shadow-2xl animate-fadeIn">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[4px] bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
                <Shield20Filled className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[var(--text-primary)] tracking-tight">
                  {t.dashboard.emergencyModalTitle}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Safe multi-step system disk recovery protocol
                </p>
              </div>
            </div>

            <div className="p-3.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="font-semibold text-[var(--text-primary)] mb-1">Actions Executed in Rescue:</div>
              <ul className="space-y-1.5 text-[var(--text-secondary)]">
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                  <span>{t.dashboard.rescueActionHiber}</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span>{t.dashboard.rescueActionTrash}</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  <span>{t.dashboard.rescueActionTemp}</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                  <span>{t.dashboard.rescueActionCrash}</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                  <span>{t.dashboard.rescueActionWsl}</span>
                </li>
              </ul>
            </div>

            {rescueResult && (
              <div className="p-3.5 bg-emerald-950/30 border border-emerald-500/30 rounded-[4px] space-y-2">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs">
                  <CheckmarkCircle24Filled className="w-4 h-4" />
                  <span>{t.dashboard.emergencySuccess} <span className="font-ibm-mono font-bold">{formatBytes(rescueResult.total_bytes_reclaimed)}</span>!</span>
                </div>
                <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                  {rescueResult.actions_performed.map((act, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 font-ibm-mono text-[11px]">
                      <Checkmark16Filled className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span>{act}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-divider)]">
              <WinUIButton
                variant="standard"
                onClick={() => setEmergencyModalOpen(false)}
                disabled={rescuing}
              >
                {rescueResult ? t.dashboard.emergencyModalClose : t.common.cancel}
              </WinUIButton>
              {!rescueResult && (
                <WinUIButton
                  variant="danger"
                  onClick={handleEmergencyRescue}
                  disabled={rescuing}
                  icon={<Flash20Filled className={`w-3.5 h-3.5 ${rescuing ? "animate-spin" : ""}`} />}
                >
                  {rescuing ? t.common.cleaning : t.dashboard.emergencyModalAction}
                </WinUIButton>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DashboardPage;
