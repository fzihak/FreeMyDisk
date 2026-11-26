import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "@/stores/settings-store";
import { useI18nStore } from "@/i18n";
import { toast } from "@/stores/toast-store";
import {
  Delete24Filled,
  Delete20Regular,
  CheckmarkCircle20Filled,
  ArrowClockwise20Regular,
  Folder20Regular,
  FolderOpen16Regular,
  Document20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Warning20Filled,
  Filter20Regular,
  CheckboxChecked20Regular,
  Sparkle20Regular,
  Code20Regular,
  Broom20Regular,
  LockClosed20Regular,
  LockClosed16Regular,
  LockOpen16Regular,
  Dismiss16Regular,
} from "@fluentui/react-icons";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, riskTone, FilterTabs, ActionBar } from "@/components/ui";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import { ProjectArtifactsView } from "@/components/cleanup/ProjectArtifactsView";
import { AiAndToolchainsView } from "@/components/cleanup/AiAndToolchainsView";
import { useCleanupScanStore } from "@/stores/cleanup-scan-store";
import type { RuleScanSummary } from "@/types/cleanup";
import { describeDisposal } from "@/utils/disposal";

/** Fills `{name}` placeholders in a translated string. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

interface DisposalItemResult {
  path: string;
  success: boolean;
  bytes_freed: number;
  route_used: string;
  error?: string;
}

interface DisposalSummary {
  session_id: string;
  total_requested_items: number;
  successful_items: number;
  failed_items: number;
  total_freed_bytes: number;
  recycled_bytes?: number;
  results: DisposalItemResult[];
  failed_trash_paths: string[];
}

export const CleanupPage: React.FC = () => {
  const { alwaysTrashOverride, confirmBeforeDelete } = useSettingsStore();
  const { t } = useI18nStore();
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [summaries, setSummaries] = useState<RuleScanSummary[]>([]);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [lastDisposal, setLastDisposal] = useState<DisposalSummary | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [mainTab, setMainTab] = useState<"system" | "projects" | "aiAndToolchains">("system");
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  // Manual Follow-up Modal for failed trash
  // Items the Recycle Bin refused, handled one after another.
  const [failedQueue, setFailedQueue] = useState<string[]>([]);
  const [failedTotal, setFailedTotal] = useState(0);
  const manualConflictPath = failedQueue[0] ?? null;
  const resolveCurrentConflict = () => setFailedQueue((queue) => queue.slice(1));
  const [resolvingPath, setResolvingPath] = useState(false);

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const applyScanResults = (results: RuleScanSummary[]) => {
    setSummaries(results);
    const autoSelected = new Set<string>();
    results.forEach((r) => {
      if (r.default_selected && (r.candidates.length > 0 || r.total_bytes > 0)) {
        autoSelected.add(r.rule_id);
      }
    });
    setSelectedRuleIds(autoSelected);
  };

  const handleScan = async () => {
    setScanning(true);
    setLastDisposal(null);
    try {
      applyScanResults(await useCleanupScanStore.getState().scan());
    } catch (e) {
      console.error("Scan failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    // Reuse a recent scan (for example from the Dashboard) instead of scanning again.
    const cached = useCleanupScanStore.getState().fresh();
    if (cached) {
      applyScanResults(cached);
    } else {
      handleScan();
    }
  }, []);

  const toggleSelectRule = (ruleId: string) => {
    setSelectedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  };

  const toggleExpandRule = (ruleId: string) => {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  };

  const selectSmart = () => {
    const next = new Set<string>();
    summaries.forEach((r) => {
      if (r.default_selected && (r.candidates.length > 0 || r.total_bytes > 0)) {
        next.add(r.rule_id);
      }
    });
    setSelectedRuleIds(next);
  };

  const selectAll = () => {
    const next = new Set<string>();
    summaries.forEach((r) => {
      if (r.candidates.length > 0 || r.total_bytes > 0) {
        next.add(r.rule_id);
      }
    });
    setSelectedRuleIds(next);
  };

  const clearSelection = () => {
    setSelectedRuleIds(new Set());
  };

  // Largest reclaimable size first; rules with nothing to clean (0 B) sink to the bottom.
  const filteredSummaries = summaries
    .filter((r) => {
      if (activeCategory === "all") return true;
      return r.category.toLowerCase() === activeCategory.toLowerCase();
    })
    .sort((a, b) => b.total_bytes - a.total_bytes);

  const totalSelectedBytes = summaries
    .filter((r) => selectedRuleIds.has(r.rule_id))
    .reduce((acc, r) => acc + r.total_bytes, 0);

  const totalSelectedItems = summaries
    .filter((r) => selectedRuleIds.has(r.rule_id))
    .reduce((acc, r) => acc + r.total_items, 0);

  const handleExecuteCleanup = async () => {
    if (selectedRuleIds.size === 0) return;
    setCleaning(true);
    try {
      const result = await invoke<DisposalSummary>("execute_cleanup_rules", {
        plan: {
          rule_ids: Array.from(selectedRuleIds),
          dry_run: false,
          force_permanent: !alwaysTrashOverride,
          close_locking_apps: false,
        },
      });

      setLastDisposal(result);
      setSelectedRuleIds(new Set());
      setExpandedRules(new Set());
      handleScan();

      const failedTrash = result?.failed_trash_paths ?? [];
      if (failedTrash.length > 0) {
        toast.warning(
          t.cleanup.trashFailedTitle,
          `${failedTrash.length} items require manual disposal decisions.`
        );
        setFailedQueue(failedTrash);
        setFailedTotal(failedTrash.length);
      } else {
        toast.success(
          t.cleanup.cleanComplete,
          describeDisposal(result, t, formatBytes)
        );
      }
    } catch (e) {
      console.error("Cleanup execution failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setCleaning(false);
    }
  };

  const handleCloseAllLockingProcesses = async () => {
    const lockedNames = Array.from(
      new Set(
        summaries
          .filter((r) => r.is_locked_by_process && r.locking_process_name)
          .map((r) => r.locking_process_name!)
      )
    );
    if (lockedNames.length === 0) return;
    try {
      const closed = await invoke<number>("close_all_locking_processes", {
        processNames: lockedNames,
      });
      toast.success("Applications Closed", `Closed ${closed} active application(s) to unlock cache directories.`);
      handleScan();
    } catch (e) {
      toast.error("Failed to Close", String(e));
    }
  };

  const handleRetryTrash = async (path: string) => {
    setResolvingPath(true);
    try {
      const outcome = await invoke<DisposalItemResult>("retry_failed_trash", { path });
      if (outcome.success) {
        resolveCurrentConflict();
      } else {
        toast.error(t.cleanup.trashFailedTitle, outcome.error ?? "");
      }
    } catch (e) {
      toast.error("Retry Failed", String(e));
    } finally {
      setResolvingPath(false);
    }
  };

  const handleForceDelete = async (path: string) => {
    setResolvingPath(true);
    try {
      const outcome = await invoke<DisposalItemResult>("force_delete_permanently", { path });
      if (outcome.success) {
        resolveCurrentConflict();
      } else {
        toast.error(t.cleanup.trashFailedTitle, outcome.error ?? "");
      }
    } catch (e) {
      toast.error("Permanent Delete Failed", String(e));
    } finally {
      setResolvingPath(false);
    }
  };

  const handleCloseProcess = async (processName: string) => {
    try {
      const closed = await invoke<boolean>("close_locking_process", { processName });
      if (closed) {
        toast.success("Process Closed", `Closed ${processName} to unlock cache directories.`);
      } else {
        toast.info("Process Status", `${processName} is not running.`);
      }
      handleScan();
    } catch (e) {
      toast.error("Close Failed", String(e));
    }
  };

  const getCategoryLabel = (cat: string) => {
    switch (cat) {
      case "all": return t.cleanup.allRules;
      case "system": return t.cleanup.systemCategory;
      case "browser": return t.cleanup.browserCategory;
      case "application": return t.cleanup.appCategory;
      case "development": return t.cleanup.devCategory;
      case "ai": return t.cleanup.aiCategory;
      default: return cat.charAt(0).toUpperCase() + cat.slice(1);
    }
  };

  const categories = ["all", "system", "browser", "application", "development", "ai"];

  const lockedActiveApps = Array.from(
    new Set(
      summaries
        .filter((r) => r.is_locked_by_process && r.locking_process_name)
        .map((r) => r.locking_process_name!)
    )
  );

  const rulesWithData = summaries.filter((r) => r.candidates.length > 0 || r.total_bytes > 0).length;
  const totalCleanableBytes = summaries.reduce((acc, r) => acc + r.total_bytes, 0);
  const lockedRuleCount = summaries.filter((r) => r.is_locked_by_process).length;

  const riskLabel = (risk: string) =>
    risk === "safe" ? t.cleanup.riskSafe : risk === "low" ? t.cleanup.riskLow : t.cleanup.riskCache;

  const openConfirmOrClean = () => {
    if (confirmBeforeDelete) {
      setShowConfirmModal(true);
    } else {
      handleExecuteCleanup();
    }
  };

  const cleanLabel = (emptyLabel: string) =>
    cleaning
      ? t.common.cleaning
      : selectedRuleIds.size === 0
      ? emptyLabel
      : totalSelectedBytes === 0
      ? t.cleanup.cleanNow
      : `${t.cleanup.cleanNow} (${formatBytes(totalSelectedBytes)})`;

  return (
    <Page className="select-none">
      <PageHeader
        icon={<Delete24Filled />}
        title={t.cleanup.title}
        description={
          <>
            {t.cleanup.subtitle}{" "}
            <span className={alwaysTrashOverride ? "" : "text-[var(--brand-amber)]"}>
              {alwaysTrashOverride ? t.cleanup.routeRecycleBinNote : t.cleanup.routePermanentNote}
            </span>
          </>
        }
        actions={
          mainTab === "system" && (
            <>
              <WinUIButton
                variant="standard"
                onClick={handleScan}
                disabled={scanning || cleaning}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
              >
                {scanning ? t.common.scanning : t.cleanup.rescan}
              </WinUIButton>
              <WinUIButton
                variant="primary"
                onClick={openConfirmOrClean}
                disabled={selectedRuleIds.size === 0 || cleaning || scanning}
                icon={<Delete20Regular className="w-4 h-4" />}
              >
                {cleanLabel(t.cleanup.selectToClean)}
              </WinUIButton>
            </>
          )
        }
      />

      {/* Primary section switcher: System Cleaners / Developer Projects / AI & Toolchains */}
      <FilterTabs
        items={[
          {
            id: "system",
            label: (
              <>
                <Delete20Regular className="w-4 h-4" />
                {t.cleanup.tabSystemCleaners}
              </>
            ),
            count: summaries.length,
          },
          {
            id: "projects",
            label: (
              <>
                <Code20Regular className="w-4 h-4" />
                {t.cleanup.tabDeveloperProjects}
              </>
            ),
          },
          {
            id: "aiAndToolchains",
            label: (
              <>
                <Sparkle20Regular className="w-4 h-4" />
                {t.cleanup.tabAiAndToolchains}
              </>
            ),
          },
        ]}
        value={mainTab}
        onChange={setMainTab}
        className="border-b border-[var(--border-divider)] pb-3"
      />

      {mainTab === "projects" ? (
        <ProjectArtifactsView />
      ) : mainTab === "aiAndToolchains" ? (
        <AiAndToolchainsView />
      ) : (
        <>
          {/* Stat row */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.cleanup.statTotalCleanable}
              value={formatBytes(totalCleanableBytes)}
              hint={fill(t.cleanup.statRulesHint, { count: summaries.length })}
              icon={<Broom20Regular />}
            />
            <StatCard
              label={t.cleanup.statSelected}
              value={formatBytes(totalSelectedBytes)}
              tone={selectedRuleIds.size > 0 ? "accent" : "neutral"}
              hint={fill(t.cleanup.statSelectedHint, {
                count: selectedRuleIds.size,
                files: totalSelectedItems.toLocaleString(),
              })}
              icon={<CheckboxChecked20Regular />}
            />
            <StatCard
              label={t.cleanup.statRulesWithData}
              value={rulesWithData}
              hint={fill(t.cleanup.statRulesWithDataHint, { total: summaries.length })}
              icon={<Filter20Regular />}
            />
            <StatCard
              label={t.cleanup.statNeedsAttention}
              value={lockedRuleCount}
              tone={lockedRuleCount > 0 ? "warning" : "neutral"}
              hint={lockedRuleCount > 0 ? t.cleanup.statNeedsAttentionHint : t.cleanup.statAllClear}
              icon={<LockClosed20Regular />}
            />
          </div>

          {/* Result of the last cleanup */}
          {lastDisposal && (
            <Card className="space-y-3 animate-fadeIn">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <CheckmarkCircle20Filled className="w-5 h-5 text-[var(--success)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{t.cleanup.cleanComplete}</div>
                    <div className="text-sm text-[var(--text-secondary)]">
                      {describeDisposal(lastDisposal, t, formatBytes)} ({lastDisposal.successful_items} {t.common.files}).
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                    {fill(t.cleanup.session, { id: `${lastDisposal.session_id.substring(0, 8)}…` })}
                  </span>
                  <WinUIButton variant="subtle" size="sm" onClick={() => setLastDisposal(null)} title={t.common.dismiss}>
                    <Dismiss16Regular className="w-4 h-4" />
                  </WinUIButton>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: t.cleanup.reclaimedSpace, value: formatBytes(lastDisposal.total_freed_bytes), cls: "text-[var(--success)]" },
                  { label: t.cleanup.movedToRecycleBin, value: formatBytes(lastDisposal.recycled_bytes ?? 0), cls: "text-[var(--text-primary)]" },
                  {
                    label: t.cleanup.filesCleaned,
                    value: `${lastDisposal.successful_items} / ${lastDisposal.total_requested_items}`,
                    cls: "text-[var(--text-primary)]",
                  },
                  {
                    label: t.cleanup.failedTrash,
                    value: String(lastDisposal.failed_items),
                    cls: lastDisposal.failed_items > 0 ? "text-[var(--brand-amber)]" : "text-[var(--success)]",
                  },
                ].map((s) => (
                  <div key={s.label} className="px-3 py-2 rounded-md bg-[var(--fill-subtle)]">
                    <div className="text-xs text-[var(--text-secondary)]">{s.label}</div>
                    <div className={`text-base font-semibold font-ibm-mono tabular-nums mt-0.5 ${s.cls}`}>{s.value}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Apps locking cache folders */}
          {lockedActiveApps.length > 0 && (
            <Card className="py-3 border-[color-mix(in_srgb,var(--brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--brand-amber)_8%,var(--bg-card))] flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fadeIn">
              <div className="flex items-start gap-2.5 text-sm text-[var(--text-primary)] min-w-0">
                <Warning20Filled className="w-5 h-5 text-[var(--brand-amber)] shrink-0" />
                <span>
                  {fill(t.cleanup.lockedAppsWarning, {
                    count: lockedActiveApps.length,
                    apps: lockedActiveApps.join(", "),
                  })}
                </span>
              </div>
              <WinUIButton
                variant="standard"
                size="sm"
                onClick={handleCloseAllLockingProcesses}
                icon={<LockOpen16Regular className="w-4 h-4" />}
                className="shrink-0"
              >
                {t.cleanup.closeAllUnlock}
              </WinUIButton>
            </Card>
          )}

          {/* Category filter + selection shortcuts */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterTabs
              items={categories.map((cat) => ({ id: cat, label: getCategoryLabel(cat) }))}
              value={activeCategory}
              onChange={setActiveCategory}
              className="min-w-0"
            />
            <div className="flex items-center gap-1 shrink-0">
              <WinUIButton
                variant="subtle"
                size="sm"
                onClick={selectSmart}
                icon={<Sparkle20Regular className="w-4 h-4 text-[var(--accent-text)]" />}
              >
                {t.cleanup.smartSelect}
              </WinUIButton>
              <WinUIButton variant="subtle" size="sm" onClick={selectAll}>
                {t.cleanup.selectAll}
              </WinUIButton>
              <WinUIButton variant="subtle" size="sm" onClick={clearSelection}>
                {t.cleanup.clear}
              </WinUIButton>
            </div>
          </div>

          {/* Rule list */}
          <Card padded={false} className="overflow-hidden">
            {scanning ? (
              <div className="p-4">
                <LiveScanProgressWidget scanType="cleanup" title={t.cleanup.scanningFiles} />
              </div>
            ) : cleaning ? (
              <div className="p-4">
                <LiveScanProgressWidget scanType="disposal" title={t.common.cleaning} showCancel={false} />
              </div>
            ) : filteredSummaries.length === 0 ? (
              <div className="py-12 px-4 text-center space-y-1.5">
                <CheckmarkCircle20Filled className="w-8 h-8 text-[var(--success)] mx-auto" />
                <h3 className="font-semibold text-[var(--text-primary)] text-base">{t.cleanup.allCleanTitle}</h3>
                <p className="text-sm text-[var(--text-secondary)]">{t.cleanup.allCleanDesc}</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-divider)]">
                {filteredSummaries.map((rule) => {
                  const isSelected = selectedRuleIds.has(rule.rule_id);
                  const isExpanded = expandedRules.has(rule.rule_id);
                  const hasCandidates = rule.candidates.length > 0 || rule.total_bytes > 0;

                  return (
                    <div key={rule.rule_id}>
                      <div
                        className={`px-4 py-3 flex items-center gap-3 transition-colors hover:bg-[var(--fill-subtle)] ${
                          hasCandidates ? "" : "opacity-60"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!hasCandidates}
                          onChange={() => toggleSelectRule(rule.rule_id)}
                          className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                          aria-label={rule.rule_name}
                        />

                        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => toggleExpandRule(rule.rule_id)}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-[var(--text-primary)] truncate">{rule.rule_name}</span>
                            <Badge>{getCategoryLabel(rule.category)}</Badge>
                            <Badge tone={riskTone(rule.risk)}>{riskLabel(rule.risk)}</Badge>
                            {rule.is_locked_by_process && (
                              <Badge tone="warning">
                                <LockClosed16Regular className="w-3.5 h-3.5" />
                                {fill(t.cleanup.appInUse, { app: rule.locking_process_name ?? "" })}
                              </Badge>
                            )}
                            {rule.is_locked_by_process && rule.locking_process_name && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCloseProcess(rule.locking_process_name!);
                                }}
                                className="h-5 px-2 rounded text-xs font-medium text-[var(--brand-amber)] border border-[color-mix(in_srgb,var(--brand-amber)_45%,transparent)] hover:bg-[var(--fill-subtle-hover)] cursor-pointer transition-colors"
                                title={fill(t.cleanup.closeAppUnlockTitle, { app: rule.locking_process_name })}
                              >
                                {t.cleanup.closeAppUnlock}
                              </button>
                            )}
                          </div>
                          <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                            {rule.default_action === "trash" ? t.cleanup.routesRecycleBin : t.cleanup.safeCleanupAction}
                          </p>
                        </div>

                        <div className="shrink-0 text-right font-ibm-mono tabular-nums">
                          <div className="text-sm font-semibold text-[var(--text-primary)]">{formatBytes(rule.total_bytes)}</div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {rule.total_items} {t.common.items}
                          </div>
                        </div>

                        <button
                          onClick={() => toggleExpandRule(rule.rule_id)}
                          className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--fill-subtle-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                          title={t.cleanup.expandDetails}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? <ChevronDown16Regular className="w-4 h-4" /> : <ChevronRight16Regular className="w-4 h-4" />}
                        </button>
                      </div>

                      {/* Matching files */}
                      {isExpanded && (
                        <div className="border-t border-[var(--border-divider)] bg-[var(--fill-subtle)] px-4 py-3 space-y-1 max-h-60 overflow-y-auto scrollbar-thin">
                          <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)] mb-1.5">
                            <span>
                              {t.cleanup.matchingFiles} ({rule.candidates.length > 0 ? rule.candidates.length : rule.total_items})
                            </span>
                            {rule.total_items > rule.candidates.length && rule.candidates.length > 0 && (
                              <span className="text-[var(--accent-text)]">
                                {t.cleanup.previewNotice} ({rule.candidates.length}/{rule.total_items})
                              </span>
                            )}
                          </div>
                          {rule.candidates.length === 0 ? (
                            <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md bg-[var(--bg-card)] border border-[var(--border-card)]">
                              <div className="flex items-center gap-2 min-w-0 text-[var(--text-secondary)]">
                                <Folder20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                                <span className="truncate text-xs">
                                  {rule.rule_id === "windows_recycle_bin"
                                    ? fill(t.cleanup.recycleBinItems, { count: rule.total_items })
                                    : fill(t.cleanup.ruleCacheFiles, { name: rule.rule_name, count: rule.total_items })}
                                </span>
                              </div>
                              <span className="text-xs text-[var(--text-primary)] font-ibm-mono tabular-nums shrink-0">
                                {formatBytes(rule.total_bytes)}
                              </span>
                            </div>
                          ) : (
                            rule.candidates.map((cand, cIdx) => (
                              <div
                                key={cIdx}
                                className="flex items-center justify-between gap-3 px-2.5 py-1 rounded-md bg-[var(--bg-card)] border border-[var(--border-card)]"
                              >
                                <div className="flex items-center gap-2 min-w-0 text-[var(--text-secondary)]">
                                  {cand.is_dir ? (
                                    <Folder20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                                  ) : (
                                    <Document20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                                  )}
                                  <span className="truncate font-code text-xs select-all">{cand.path}</span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <span className="text-xs text-[var(--text-primary)] font-ibm-mono tabular-nums">
                                    {formatBytes(cand.size_bytes)}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      revealItemInDir(cand.path).catch((err) => console.warn("Failed to reveal item in Explorer:", err));
                                    }}
                                    className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent-text)] hover:bg-[var(--fill-subtle-hover)] transition-colors cursor-pointer"
                                    title={t.cleanup.openInExplorer}
                                  >
                                    <FolderOpen16Regular className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Selection action bar */}
          {selectedRuleIds.size > 0 && (
            <ActionBar
              summary={
                <>
                  <span className="text-[var(--text-primary)] font-medium">
                    {fill(t.cleanup.selectedSummary, {
                      count: selectedRuleIds.size,
                      size: formatBytes(totalSelectedBytes),
                    })}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {" · "}
                    {fill(t.cleanup.selectedFiles, { files: totalSelectedItems.toLocaleString() })}
                  </span>
                </>
              }
            >
              <WinUIButton variant="subtle" onClick={clearSelection}>
                {t.common.deselectAll}
              </WinUIButton>
              <WinUIButton
                variant="primary"
                onClick={openConfirmOrClean}
                disabled={cleaning || scanning || selectedRuleIds.size === 0}
                icon={<Delete20Regular className="w-4 h-4" />}
              >
                {cleanLabel(t.cleanup.cleanNow)}
              </WinUIButton>
            </ActionBar>
          )}
        </>
      )}

      {/* Safety Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <Card className="max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center text-[var(--accent-text)] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-base">{t.settings.confirmDelete}</h3>
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                  Clean {selectedRuleIds.size} rule category(s) and free approx{" "}
                  <span className="font-semibold text-[var(--text-primary)] font-ibm-mono">{formatBytes(totalSelectedBytes)}</span>.
                </p>
              </div>
            </div>

            <div className="rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] text-sm divide-y divide-[var(--border-divider)]">
              <div className="flex justify-between px-3 py-2 text-[var(--text-secondary)]">
                <span>{t.cleanup.itemsSelected}</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-semibold">{selectedRuleIds.size}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-[var(--text-secondary)]">
                <span>{t.cleanup.filesCleaned}</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-semibold">{totalSelectedItems.toLocaleString()}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-[var(--text-secondary)]">
                <span>Safety route</span>
                <span className={`font-semibold ${alwaysTrashOverride ? "text-[var(--success)]" : "text-[var(--brand-amber)]"}`}>
                  {alwaysTrashOverride ? "Recycle Bin (Safe)" : "Immediate Purge"}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton variant="standard" onClick={() => setShowConfirmModal(false)} disabled={cleaning}>
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="primary"
                onClick={() => {
                  setShowConfirmModal(false);
                  handleExecuteCleanup();
                }}
                disabled={cleaning}
              >
                {t.cleanup.cleanNow}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}

      {/* Manual Conflict Modal for Failed Trash Deletions */}
      {manualConflictPath && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <Card className="max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center text-[var(--brand-amber)] shrink-0">
                <Warning20Filled className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-base">
                  {t.cleanup.trashFailedTitle}
                  {failedTotal > 1 && (
                    <span className="ml-2 font-ibm-mono text-xs text-[var(--text-muted)]">
                      {failedTotal - failedQueue.length + 1} / {failedTotal}
                    </span>
                  )}
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">{t.cleanup.trashFailedDesc}</p>
              </div>
            </div>

            <div className="px-3 py-2 rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] font-code text-xs text-[var(--text-secondary)] break-all select-all">
              {manualConflictPath}
            </div>

            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{t.cleanup.trashFailedHelp}</p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton variant="standard" onClick={resolveCurrentConflict} disabled={resolvingPath}>
                {t.cleanup.keepFileAction}
              </WinUIButton>
              <WinUIButton variant="standard" onClick={() => handleRetryTrash(manualConflictPath)} disabled={resolvingPath}>
                {t.cleanup.retryTrash}
              </WinUIButton>
              <WinUIButton variant="danger" onClick={() => handleForceDelete(manualConflictPath)} disabled={resolvingPath}>
                {t.cleanup.permanentDeleteAction}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default CleanupPage;
