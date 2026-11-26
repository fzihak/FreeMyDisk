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
  Sparkle20Filled,
  ArrowClockwise20Regular,
  CheckmarkCircle24Filled,
  Checkmark16Filled,
  Dismiss16Filled,
  Warning16Filled,
  ErrorCircle24Filled,
  Shield20Filled,
  Delete20Regular,
  Storage20Regular,
  DocumentFolder20Regular,
  DocumentCopy20Regular,
  ShieldCheckmark20Regular,
  Apps20Regular,
  Flash20Regular,
  Wrench20Regular,
  Gauge20Regular,
  Flash20Filled,
} from "@fluentui/react-icons";
import { Page, PageHeader, Card, Badge, ProgressBar, FilterTabs, SectionTitle } from "@/components/ui";
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
  const [confirmEmptyBin, setConfirmEmptyBin] = useState(false);
  const [binFiles, setBinFiles] = useState<number | null>(null);
  // Bytes really on disk in the bin folders, including leftovers Windows no longer counts.
  const [binDiskBytes, setBinDiskBytes] = useState<number>(0);

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
      invoke<{ files: number; bytes: number }>("get_recycle_bin_contents")
        .then((c) => {
          setBinFiles(c.files);
          setBinDiskBytes(c.bytes);
        })
        .catch(() => setBinFiles(null));
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
  const binProgress = useScanProgress("recycle_bin");
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
    resetProgress("recycle_bin");
    setEmptyingBin(true);
    try {
      const reclaimed = await invoke<number>("empty_recycle_bin");
      toast.success(
        t.dashboard.rescueActionTrash,
        `${formatBytes(reclaimed)} ${t.dashboard.reclaimedNotice}`
      );
      setRecycleBin({ total_bytes: 0, item_count: 0 });
      setBinFiles(0);
      setBinDiskBytes(0);
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

  const drivePercentFree = volumeTotalBytes > 0 ? 100 - volumePercentUsed : 100;
  const driveLow = drivePercentFree < 15;

  const tools: Array<{
    id: NavTab;
    title: string;
    desc: string;
    icon: React.ReactNode;
    badge?: React.ReactNode;
  }> = [
    {
      id: "cleanup",
      title: t.nav.cleanup,
      desc: t.dashboard.deepCleanupDesc,
      icon: <Delete20Regular />,
      badge: totalCleanableBytes > 0 ? <Badge tone="accent">{formatBytes(totalCleanableBytes)}</Badge> : undefined,
    },
    { id: "storage", title: t.nav.storage, desc: t.dashboard.treemapDesc, icon: <Storage20Regular /> },
    { id: "large_files", title: t.nav.largeFiles, desc: t.dashboard.largeFilesDesc, icon: <DocumentFolder20Regular /> },
    { id: "duplicates", title: t.nav.duplicates, desc: t.dashboard.duplicatesDesc, icon: <DocumentCopy20Regular /> },
    { id: "privacy", title: t.nav.privacy, desc: t.dashboard.privacyDesc, icon: <ShieldCheckmark20Regular /> },
    { id: "applications", title: t.nav.applications, desc: t.dashboard.appsDesc, icon: <Apps20Regular /> },
    {
      id: "startup",
      title: t.nav.startup,
      desc: t.dashboard.startupDesc,
      icon: <Flash20Regular />,
      badge:
        highImpactStartups > 0 ? (
          <Badge tone="warning">{fill(t.dashboard.highImpactCount, { count: highImpactStartups })}</Badge>
        ) : undefined,
    },
    { id: "maintenance", title: t.nav.maintenance, desc: t.dashboard.maintenanceDesc, icon: <Wrench20Regular /> },
    { id: "optimization", title: t.nav.optimization, desc: t.dashboard.optimizerDesc, icon: <Gauge20Regular /> },
  ];

  const binBytes = Math.max(recycleBin?.total_bytes ?? 0, binDiskBytes);
  const binEmpty = binBytes === 0 && !binFiles;

  return (
    <Page>
      <PageHeader
        title={t.dashboard.title}
        description={
          vitals
            ? `${vitals.os_name} · ${vitals.cpu_cores} ${t.dashboard.cpuCores}`
            : t.dashboard.subtitle
        }
      />

      {/* Hero: selected drive on the left, the one-click cleaner on the right */}
      <Card className="p-6">
        <div className="grid gap-6 md:grid-cols-[minmax(0,320px)_1fr]">
          <div className="flex flex-col items-center md:items-start gap-4">
            <div className="flex items-center gap-4">
              <DriveRing percent={volumePercentUsed} danger={driveLow} />
              <div className="min-w-0">
                <div className="text-base font-semibold truncate">
                  {currentVolume ? volumeLabel(currentVolume) : t.dashboard.driveSpaceTitle}
                </div>
                {currentVolume ? (
                  <>
                    <div className="text-sm text-[var(--text-secondary)] font-ibm-mono">
                      {fill(t.dashboard.usedOfTotal, {
                        used: formatBytes(volumeUsedBytes),
                        total: formatBytes(volumeTotalBytes),
                      })}
                    </div>
                    <div
                      className={`text-sm font-ibm-mono ${driveLow ? "text-[var(--danger)]" : "text-[var(--success)]"}`}
                    >
                      {fill(t.dashboard.freeSpaceValue, { size: formatBytes(currentVolume.available_bytes) })}
                    </div>
                  </>
                ) : (
                  <div className="w-32 h-3 mt-1 rounded bg-[var(--fill-subtle)] animate-pulse" />
                )}
              </div>
            </div>
            {volumes.length > 1 && (
              <FilterTabs
                items={volumes.map((v, idx) => ({ id: String(idx), label: v.mount_point.replace(/\\$/, "") }))}
                value={String(selectedVolumeIdx)}
                onChange={(id) => setSelectedVolumeIdx(Number(id))}
                className="max-w-full"
              />
            )}
          </div>

          <div className="md:border-l md:border-[var(--border-divider)] md:pl-6 flex flex-col justify-center gap-3 min-w-0">
            <div className="text-sm text-[var(--text-secondary)]">{t.dashboard.quickScanTitle}</div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[40px] leading-none font-semibold font-ibm-mono">
                {scanning ? `${scanProgress}%` : scanCompleted ? formatBytes(totalCleanableBytes) : "—"}
              </span>
              <span className="text-sm text-[var(--text-secondary)]">
                {scanning ? t.dashboard.scanningHeadline : scanCompleted ? t.dashboard.readyToClean : ""}
              </span>
              {refreshing && (
                <span className="inline-flex items-center gap-1 text-xs text-[var(--accent-text)]">
                  <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin" />
                  {t.dashboard.refreshingResults}
                </span>
              )}
            </div>

            {scanning ? (
              <div className="space-y-1.5">
                <ProgressBar value={Math.max(1, scanProgress)} />
                <div className="text-xs text-[var(--text-muted)] truncate">
                  {cleanupProgress.currentPath || scanStage}
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-xs text-[var(--text-muted)]">
                  {scanCompleted
                    ? fill(t.dashboard.categoriesInspected, { count: inspectedCount })
                    : t.dashboard.categoriesHint}
                </div>
                {scanCompleted && quickClean.adminBytes > 0 && (
                  <Note>{fill(t.dashboard.moreNeedsAdmin, { size: formatBytes(quickClean.adminBytes) })}</Note>
                )}
                {scanCompleted && quickClean.lockedBytes > 0 && (
                  <Note>
                    {fill(t.dashboard.moreNeedsAppsClosed, {
                      size: formatBytes(quickClean.lockedBytes),
                      apps: quickClean.lockedApps.join(", ") || "apps",
                    })}
                  </Note>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
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
        </div>

        {/* Outcome of the last one-click clean */}
        {lastClean && !scanning && (
          <div className="mt-5 pt-4 border-t border-[var(--border-divider)] space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="flex items-center gap-1.5 font-semibold text-[var(--success)]">
                <CheckmarkCircle24Filled className="w-4 h-4" />
                {t.dashboard.lastCleanTitle}
              </span>
              {lastClean.total_freed_bytes > 0 && (
                <span className="font-ibm-mono">
                  {fill(t.dashboard.lastCleanFreed, { size: formatBytes(lastClean.total_freed_bytes) })}
                </span>
              )}
              {(lastClean.recycled_bytes ?? 0) > 0 && (
                <span className="font-ibm-mono">
                  {fill(t.dashboard.lastCleanRecycled, { size: formatBytes(lastClean.recycled_bytes ?? 0) })}
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
                <span className="text-[var(--brand-amber)]">
                  {fill(t.dashboard.lastCleanFailed, { count: lastClean.failed_items ?? 0 })}
                </span>
              )}
            </div>
            {cleanIssues.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {cleanIssues.map(([reason, count]) => (
                  <Badge key={reason} tone="warning">
                    <Warning16Filled className="w-3 h-3" />
                    {reason} · {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Status row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
            <span>{t.dashboard.recycleBinTitle}</span>
            <Delete20Regular className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          <div>
            <div className="text-2xl font-semibold font-ibm-mono">
              {formatBytes(binBytes)}
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {binEmpty
                ? t.dashboard.binIsEmpty
                : binFiles && binFiles > (recycleBin?.item_count ?? 0)
                ? fill(t.dashboard.recycleItemsFiles, {
                    count: recycleBin?.item_count ?? 0,
                    files: binFiles.toLocaleString(),
                  })
                : fill(t.dashboard.recycleItems, { count: recycleBin?.item_count ?? 0 })}
            </div>
          </div>
          {emptyingBin && (
            <div className="space-y-1">
              <ProgressBar value={Math.max(1, binProgress.percent)} tone="danger" />
              <div className="text-xs text-[var(--text-muted)] font-ibm-mono">
                {Number(binProgress.currentPath) > 0
                  ? fill(t.dashboard.binFilesProgress, {
                      done: binProgress.itemsScanned.toLocaleString(),
                      total: Number(binProgress.currentPath).toLocaleString(),
                    })
                  : t.dashboard.emptyingBin}
              </div>
            </div>
          )}
          <div className="mt-auto">
            <WinUIButton
              variant={confirmEmptyBin ? "danger" : "standard"}
              size="sm"
              disabled={binEmpty || emptyingBin}
              onClick={() => {
                if (confirmEmptyBin) {
                  setConfirmEmptyBin(false);
                  handleEmptyRecycleBin();
                } else {
                  setConfirmEmptyBin(true);
                  window.setTimeout(() => setConfirmEmptyBin(false), 4000);
                }
              }}
            >
              {emptyingBin
                ? t.dashboard.emptyingBin
                : confirmEmptyBin
                ? t.dashboard.confirmEmptyBin
                : t.dashboard.emptyBin}
            </WinUIButton>
          </div>
        </Card>

        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
            <span>{t.dashboard.memoryTitle}</span>
            <Gauge20Regular className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold font-ibm-mono">
                {vitals ? `${vitals.memory_load_percent}%` : "—"}
              </span>
              {vitals && (
                <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                  {fill(t.dashboard.usedOfTotal, {
                    used: formatBytes(vitals.used_ram_bytes || 0),
                    total: formatBytes(vitals.total_ram_bytes || 0),
                  })}
                </span>
              )}
            </div>
            <ProgressBar
              value={vitals?.memory_load_percent ?? 0}
              tone={(vitals?.memory_load_percent ?? 0) > 85 ? "danger" : (vitals?.memory_load_percent ?? 0) > 70 ? "warning" : "accent"}
            />
          </div>
          <div className="mt-auto">
            <WinUIButton variant="standard" size="sm" onClick={handleBoostRam} disabled={boostingRam || !vitals}>
              {boostingRam ? t.dashboard.boostingMemory : t.dashboard.boostMemory}
            </WinUIButton>
          </div>
        </Card>

        <Card
          className={`flex flex-col gap-3 ${isDiskCritical ? "border-[color-mix(in_srgb,var(--danger)_45%,transparent)]" : ""}`}
        >
          <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
            <span>{t.dashboard.diskSpaceTitle}</span>
            {isDiskCritical ? (
              <Warning16Filled className="w-4 h-4 text-[var(--danger)]" />
            ) : (
              <CheckmarkCircle24Filled className="w-4 h-4 text-[var(--success)]" />
            )}
          </div>
          <div>
            <div
              className={`text-base font-semibold ${isDiskCritical ? "text-[var(--danger)]" : "text-[var(--success)]"}`}
            >
              {isDiskCritical ? t.dashboard.diskLow : t.dashboard.diskOk}
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {isDiskCritical ? t.dashboard.emergencyBannerDesc : t.dashboard.diskOkDesc}
            </div>
          </div>
          <div className="mt-auto">
            <WinUIButton variant={isDiskCritical ? "danger" : "subtle"} size="sm" onClick={openRescueModal}>
              {isDiskCritical ? t.dashboard.emergencyRescueButton : t.dashboard.emergencyRescueShort}
            </WinUIButton>
          </div>
        </Card>
      </div>

      {/* Tools */}
      <SectionTitle>{t.dashboard.toolsTitle}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => onNavigate(tool.id)}
            className="group text-left bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-card)] rounded-lg p-4 flex items-start gap-3 transition-colors shadow-[var(--shadow-card)]"
          >
            <span className="w-9 h-9 shrink-0 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--accent-text)] [&_svg]:w-5 [&_svg]:h-5">
              {tool.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold truncate">{tool.title}</span>
                {tool.badge}
              </span>
              <span className="block text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-2">{tool.desc}</span>
            </span>
          </button>
        ))}
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
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
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
                <div className="text-xs text-[var(--text-secondary)] break-words">{rescueError}</div>
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
                        <div key={s.step} className="flex items-start gap-1.5 text-xs">
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
                        <div key={idx} className="flex items-center gap-1.5 font-ibm-mono text-xs">
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
    </Page>
  );
};

export default DashboardPage;

/** Ring showing how full a drive is. Turns red when free space is low. */
const DriveRing: React.FC<{ percent: number; danger?: boolean }> = ({ percent, danger }) => {
  const size = 96;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-subtle-hover)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={danger ? "var(--danger-fill)" : "var(--accent)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p / 100)}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold font-ibm-mono">{p}%</span>
      </div>
    </div>
  );
};

/** Small amber note line with a warning icon. */
const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-1.5 text-xs text-[var(--brand-amber)]">
    <Warning16Filled className="w-3.5 h-3.5 shrink-0" />
    <span className="truncate">{children}</span>
  </div>
);
