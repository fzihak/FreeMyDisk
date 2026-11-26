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
  Dismiss16Filled,
  Warning16Filled,
  ErrorCircle24Filled,
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

interface DisposalItemResult {
  path: string;
  success: boolean;
  bytes_freed: number;
  route_used: string;
  error?: string | null;
}

interface DisposalSummary {
  session_id?: string;
  total_requested_items?: number;
  successful_items?: number;
  failed_items?: number;
  skipped_items?: number;
  total_freed_bytes: number;
  recycled_bytes?: number;
  results?: DisposalItemResult[];
}

type RescueStepId = "recycle_bin" | "temp_files" | "hibernation" | "wsl";

interface RescueStepOutcome {
  step: RescueStepId;
  status: "done" | "skipped" | "failed";
  bytes_reclaimed: number;
  message: string;
}

interface EmergencyRescueResult {
  total_bytes_reclaimed: number;
  hibernation_disabled: boolean;
  recycle_bin_emptied: boolean;
  temp_cleaned_bytes: number;
  wsl_shutdown: boolean;
  actions_performed: string[];
  steps?: RescueStepOutcome[];
}

interface QuickCleanRequirements {
  is_elevated: boolean;
  rules: { rule_id: string; admin_bytes: number; admin_items: number }[];
}

/** Rescue steps in the order the backend runs them. */
const RESCUE_STEPS: RescueStepId[] = ["recycle_bin", "temp_files", "hibernation", "wsl"];

/** Fills `{name}` placeholders in a translated string. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** "Local Disk (C:)" stays as is; a name without the drive gets it appended once. */
const volumeLabel = (v: { volume_name: string; mount_point: string }): string => {
  const drive = v.mount_point.replace(/[\\/]+$/, "");
  const name = (v.volume_name || "").trim();
  if (!name) return drive;
  return name.toUpperCase().includes(drive.toUpperCase()) ? name : `${name} (${drive})`;
};

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
  const [rescueError, setRescueError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [scanStage, setScanStage] = useState<string>("");
  const [scanCompleted, setScanCompleted] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [lastClean, setLastClean] = useState<DisposalSummary | null>(null);
  const [requirements, setRequirements] = useState<QuickCleanRequirements | null>(null);
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

  /** Asks which scanned items need administrator rights, for the rules given. */
  const loadRequirements = async (summaries: RuleScanSummary[]) => {
    const ids = summaries.filter((r) => r.rule_id !== "windows_recycle_bin").map((r) => r.rule_id);
    try {
      const req = await invoke<QuickCleanRequirements>("get_quick_clean_requirements", {
        ruleIds: ids,
      });
      setRequirements(req);
    } catch (e) {
      console.warn("Failed to load quick clean requirements:", e);
      setRequirements({ is_elevated: false, rules: [] });
    }
  };

  useEffect(() => {
    loadInitialData();
    const cached = useCleanupScanStore.getState().fresh();
    if (cached) {
      setRuleSummaries(cached);
      setScanCompleted(true);
      loadRequirements(cached);
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

  // One-click cleaning only takes what can succeed right now: rules locked by a
  // running app are left out, and so are items that need administrator rights
  // while the app is not elevated. The headline counts exactly that.
  const quickClean = useMemo(() => {
    const adminByRule = new Map<string, number>();
    if (requirements && !requirements.is_elevated) {
      for (const r of requirements.rules) adminByRule.set(r.rule_id, r.admin_bytes);
    }
    const rules: RuleScanSummary[] = [];
    let bytes = 0;
    let adminBytes = 0;
    let lockedBytes = 0;
    const lockedApps = new Set<string>();
    for (const r of ruleSummaries) {
      if (r.rule_id === "windows_recycle_bin" || r.risk !== "safe") continue;
      if (r.total_bytes <= 0 && r.total_items <= 0) continue;
      if (r.is_locked_by_process) {
        lockedBytes += r.total_bytes;
        if (r.locking_process_name) lockedApps.add(r.locking_process_name.replace(/\.exe$/i, ""));
        continue;
      }
      const admin = Math.min(adminByRule.get(r.rule_id) ?? 0, r.total_bytes);
      adminBytes += admin;
      const usable = r.total_bytes - admin;
      if (usable > 0 || (admin === 0 && r.total_items > 0)) {
        rules.push(r);
        bytes += usable;
      }
    }
    return { rules, bytes, adminBytes, lockedBytes, lockedApps: Array.from(lockedApps) };
  }, [ruleSummaries, requirements]);
  const quickCleanRules = quickClean.rules;
  const totalCleanableBytes = quickClean.bytes;
  // The Recycle Bin is reported by the scan as an extra entry, not a rule.
  const inspectedCount = ruleSummaries.filter((r) => r.rule_id !== "windows_recycle_bin").length;

  const cleanupProgress = useScanProgress("cleanup");
  const rescueProgress = useScanProgress("rescue");
  const { initProgressListener, resetProgress } = useScanProgressStore();

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

  /**
   * Runs a cleanup scan. A background refresh keeps the current numbers on screen
   * until the new ones arrive instead of switching the card to its scanning state.
   */
  const handleStartScan = async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (background) {
      setRefreshing(true);
    } else {
      setScanning(true);
      setScanCompleted(false);
      setLastClean(null);
      setScanProgress(1);
      setScanStage(t.dashboard.scanningCaches);
    }

    try {
      const summaries = await useCleanupScanStore.getState().scan();
      setRuleSummaries(summaries);
      await loadRequirements(summaries);
      setScanProgress(100);
      setScanStage(t.dashboard.scanCompletedStage);
      setScanCompleted(true);
    } catch (e) {
      console.error("Quick scan failed:", e);
      if (!background) setScanStage(t.dashboard.scanInterruptedStage);
    } finally {
      setScanning(false);
      setRefreshing(false);
    }
  };

  const handleInstantClean = async () => {
    if (quickCleanRules.length === 0) return;
    setCleaning(true);

    const ruleIdsToClean = quickCleanRules.map((r) => r.rule_id);

    try {
      // Same disposal route as the Deep Cleanup page: the Recycle Bin setting
      // decides, and only rules marked permanent bypass it when it is off.
      const summary = await invoke<DisposalSummary>("execute_cleanup_rules", {
        plan: {
          rule_ids: ruleIdsToClean,
          dry_run: false,
          force_permanent: !alwaysTrashOverride,
          close_locking_apps: false,
          skip_admin_paths: true,
        },
      });

      setLastClean(summary);
      // Cleaned rules drop out of the headline until the refresh below reports
      // what is really left.
      const cleaned = new Set(ruleIdsToClean);
      setRuleSummaries((prev) =>
        prev.map((r) => (cleaned.has(r.rule_id) ? { ...r, total_bytes: 0, total_items: 0 } : r))
      );
      loadInitialData();
      toast.success(t.cleanup.cleanComplete, describeDisposal(summary, t, formatBytes));
    } catch (e) {
      console.error("Instant clean failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setCleaning(false);
    }
    handleStartScan({ background: true });
  };

  const openRescueModal = () => {
    setRescueResult(null);
    setRescueError(null);
    setEmergencyModalOpen(true);
    // Show the current Recycle Bin contents in the confirmation.
    invoke<RecycleBinStatus>("get_recycle_bin_status")
      .then(setRecycleBin)
      .catch(() => {});
  };

  const handleEmergencyRescue = async () => {
    resetProgress("rescue");
    setRescueResult(null);
    setRescueError(null);
    setRescuing(true);
    try {
      const result = await invoke<EmergencyRescueResult>("execute_emergency_rescue");
      setRescueResult(result);
      toast.success(
        t.dashboard.emergencySuccess,
        fill(t.dashboard.rescueFinished, { size: formatBytes(result.total_bytes_reclaimed) })
      );
    } catch (e) {
      console.error("Emergency rescue failed:", e);
      setRescueError(String(e));
      toast.error(t.common.error, String(e));
    } finally {
      setRescuing(false);
      loadInitialData();
      handleStartScan({ background: true });
    }
  };

  /** Short, translated reasons for items that were not cleaned, with counts. */
  const cleanIssues = useMemo(() => {
    if (!lastClean?.results) return [];
    const counts = new Map<string, number>();
    for (const r of lastClean.results) {
      if (r.success) continue;
      const err = (r.error ?? "").toLowerCase();
      let reason: string;
      if (err === "needs_administrator") reason = t.dashboard.reasonNeedsAdmin;
      else if (err === "trash_unavailable") reason = t.dashboard.reasonTrashUnavailable;
      else if (err.includes("protected") || r.route_used === "rejected") reason = t.dashboard.reasonProtected;
      else if (err.includes("os error 32") || err.includes("in use") || err.includes("being used"))
        reason = t.dashboard.reasonInUse;
      else reason = (r.error ?? t.common.error).slice(0, 60);
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [lastClean, t]);

  const rescueStepLabel = (step: string): string => {
    switch (step) {
      case "recycle_bin":
        return t.dashboard.rescueStepRecycleBin;
      case "temp_files":
        return t.dashboard.rescueStepTemp;
      case "hibernation":
        return t.dashboard.rescueStepHibernation;
      case "wsl":
        return t.dashboard.rescueStepWsl;
      default:
        return t.common.cleaning;
    }
  };
  const rescueStepIndex = Math.min(
    RESCUE_STEPS.length,
    Math.max(1, rescueProgress.itemsScanned || 1)
  );

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
                  {scanning
                    ? t.dashboard.scanningHeadline
                    : scanCompleted
                    ? formatBytes(totalCleanableBytes)
                    : "—"}
                </span>
                {scanning ? (
                  <span className="text-xs font-medium text-[#4cc2ff] font-ibm-mono tabular-nums">
                    {scanProgress}%
                  </span>
                ) : (
                  scanCompleted &&
                  totalCleanableBytes > 0 && (
                    <span className="text-xs font-medium text-emerald-400 font-ibm-mono">
                      {t.dashboard.reclaimable}
                    </span>
                  )
                )}
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                {scanCompleted && !scanning
                  ? fill(t.dashboard.categoriesInspected, { count: inspectedCount })
                  : t.dashboard.categoriesHint}
                {refreshing && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[#4cc2ff]">
                    <ArrowClockwise20Regular className="w-3 h-3 animate-spin" />
                    {t.dashboard.refreshingResults}
                  </span>
                )}
              </p>
              {scanCompleted && !scanning && quickClean.adminBytes > 0 && (
                <p className="text-[11px] text-amber-400/90">
                  {fill(t.dashboard.moreNeedsAdmin, { size: formatBytes(quickClean.adminBytes) })}
                </p>
              )}
              {scanCompleted && !scanning && quickClean.lockedBytes > 0 && (
                <p className="text-[11px] text-amber-400/90">
                  {fill(t.dashboard.moreNeedsAppsClosed, {
                    size: formatBytes(quickClean.lockedBytes),
                    apps: quickClean.lockedApps.join(", ") || "apps",
                  })}
                </p>
              )}
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
            {scanCompleted && !scanning && (totalCleanableBytes > 0 || cleaning) ? (
              <WinUIButton
                variant="primary"
                size="lg"
                onClick={handleInstantClean}
                disabled={cleaning || refreshing}
                icon={<Sparkle20Filled className="w-4 h-4" />}
              >
                {cleaning ? t.common.cleaning : t.dashboard.cleanNow}
              </WinUIButton>
            ) : scanCompleted && !scanning ? (
              <WinUIButton variant="primary" size="lg" disabled icon={<CheckmarkCircle24Filled className="w-4 h-4" />}>
                {refreshing ? t.dashboard.refreshingResults : t.dashboard.nothingToClean}
              </WinUIButton>
            ) : (
              <WinUIButton
                variant="primary"
                size="lg"
                onClick={() => handleStartScan()}
                disabled={scanning}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
              >
                {scanning ? t.dashboard.scanningHeadline : t.dashboard.startQuickScan}
              </WinUIButton>
            )}

            {scanCompleted && (
              <WinUIButton
                variant="standard"
                size="lg"
                onClick={() => handleStartScan()}
                disabled={scanning || refreshing || cleaning}
              >
                {t.cleanup.rescan}
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

        {/* Outcome of the last one-click clean */}
        {lastClean && !scanning && (
          <div className="mt-4 pt-3 border-t border-[var(--border-divider)] space-y-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5 font-semibold text-emerald-400">
                <CheckmarkCircle24Filled className="w-4 h-4" />
                {t.dashboard.lastCleanTitle}
              </span>
              <span className="font-ibm-mono text-[var(--text-primary)]">
                {fill(t.dashboard.lastCleanFreed, { size: formatBytes(lastClean.total_freed_bytes) })}
              </span>
              {(lastClean.recycled_bytes ?? 0) > 0 && (
                <span className="font-ibm-mono text-[var(--text-secondary)]">
                  {fill(t.dashboard.lastCleanRecycled, {
                    size: formatBytes(lastClean.recycled_bytes ?? 0),
                  })}
                </span>
              )}
              <span className="text-[var(--text-secondary)]">
                {fill(t.dashboard.lastCleanItems, { count: lastClean.successful_items ?? 0 })}
              </span>
              {(lastClean.skipped_items ?? 0) > 0 && (
                <span className="text-[var(--text-muted)]">
                  {fill(t.dashboard.lastCleanSkipped, { count: lastClean.skipped_items ?? 0 })}
                </span>
              )}
              {(lastClean.failed_items ?? 0) > 0 && (
                <span className="text-amber-400">
                  {fill(t.dashboard.lastCleanFailed, { count: lastClean.failed_items ?? 0 })}
                </span>
              )}
            </div>
            {cleanIssues.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {cleanIssues.map(([reason, count]) => (
                  <span
                    key={reason}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]"
                  >
                    <Warning16Filled className="w-3 h-3" />
                    {reason} · {count}
                  </span>
                ))}
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
                    ? volumeLabel(currentVolume)
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
            subtitle={t.dashboard.duplicatesEngineDesc}
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
                  openRescueModal();
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

            {/* What will happen, listed before the user confirms */}
            {!rescuing && !rescueResult && !rescueError && (
              <div className="p-3.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] space-y-2 text-xs text-[var(--text-secondary)]">
                <div className="font-semibold text-[var(--text-primary)] mb-1">
                  {t.dashboard.rescueWillDoTitle}
                </div>
                <ul className="space-y-1.5 text-[var(--text-secondary)]">
                  <li className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-rose-400 shrink-0" />
                    <span className={recycleBin && recycleBin.total_bytes > 0 ? "text-rose-300 font-medium" : ""}>
                      {recycleBin && (recycleBin.total_bytes > 0 || recycleBin.item_count > 0)
                        ? fill(t.dashboard.rescueBinPermanent, {
                            items: recycleBin.item_count,
                            size: formatBytes(recycleBin.total_bytes),
                          })
                        : t.dashboard.rescueBinEmpty}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-cyan-400 shrink-0" />
                    <span>{t.dashboard.rescueTempSafe}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-amber-400 shrink-0" />
                    <span>{t.dashboard.rescueHiberAdmin}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-purple-400 shrink-0" />
                    <span>{t.dashboard.rescueWslNote}</span>
                  </li>
                </ul>
              </div>
            )}

            {/* Live step progress */}
            {rescuing && (
              <div className="p-3.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] space-y-2 text-xs">
                <div className="flex items-center justify-between text-[var(--text-secondary)]">
                  <span className="font-semibold text-[var(--text-primary)]">
                    {rescueStepLabel(rescueProgress.stage)}
                  </span>
                  <span className="font-ibm-mono tabular-nums">
                    {fill(t.dashboard.rescueStepCounter, {
                      current: rescueStepIndex,
                      total: RESCUE_STEPS.length,
                    })}
                  </span>
                </div>
                <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                  <div
                    style={{ width: `${Math.max(2, rescueProgress.percent)}%` }}
                    className="h-full bg-rose-500 rounded-full transition-all duration-300"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-muted)]">
                  <span className="truncate font-ibm-mono">{rescueProgress.currentPath}</span>
                  <span className="shrink-0 font-ibm-mono">
                    {fill(t.dashboard.rescueFreedSoFar, { size: formatBytes(rescueProgress.bytesFound) })}
                  </span>
                </div>
              </div>
            )}

            {rescueError && !rescuing && (
              <div className="p-3.5 bg-rose-950/30 border border-rose-500/30 rounded-[4px] space-y-1 text-xs">
                <div className="flex items-center gap-2 text-rose-400 font-semibold">
                  <ErrorCircle24Filled className="w-4 h-4" />
                  <span>{t.dashboard.rescueStopped}</span>
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] break-words">{rescueError}</div>
              </div>
            )}

            {rescueResult && (
              <div className="p-3.5 bg-emerald-950/30 border border-emerald-500/30 rounded-[4px] space-y-2">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-xs">
                  <CheckmarkCircle24Filled className="w-4 h-4" />
                  <span>
                    {fill(t.dashboard.rescueFinished, {
                      size: formatBytes(rescueResult.total_bytes_reclaimed),
                    })}
                  </span>
                </div>
                <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                  {rescueResult.steps && rescueResult.steps.length > 0
                    ? rescueResult.steps.map((s) => (
                        <div key={s.step} className="flex items-start gap-1.5 text-[11px]">
                          {s.status === "done" ? (
                            <Checkmark16Filled className="w-3 h-3 mt-0.5 text-emerald-400 shrink-0" />
                          ) : s.status === "skipped" ? (
                            <Warning16Filled className="w-3 h-3 mt-0.5 text-amber-400 shrink-0" />
                          ) : (
                            <Dismiss16Filled className="w-3 h-3 mt-0.5 text-rose-400 shrink-0" />
                          )}
                          <span>
                            <span className="font-semibold text-[var(--text-primary)]">
                              {s.status === "done"
                                ? t.dashboard.rescueStatusDone
                                : s.status === "skipped"
                                ? t.dashboard.rescueStatusSkipped
                                : t.dashboard.rescueStatusFailed}
                              :
                            </span>{" "}
                            {s.message}
                          </span>
                        </div>
                      ))
                    : rescueResult.actions_performed.map((act, idx) => (
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
                {rescueResult || rescueError ? t.dashboard.emergencyModalClose : t.common.cancel}
              </WinUIButton>
              {!rescueResult && !rescueError && (
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
