import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "@/stores/settings-store";
import { useI18nStore } from "@/i18n";
import { toast } from "@/stores/toast-store";
import {
  Delete24Filled,
  Delete20Regular,
  CheckmarkCircle24Filled,
  ArrowClockwise20Regular,
  Folder20Regular,
  FolderOpen16Regular,
  Document20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Warning20Filled,
  Filter20Regular,
  CheckboxChecked20Filled,
  CheckboxUnchecked20Regular,
  Sparkle20Filled,
  DismissCircle20Regular,
  Code20Regular,
} from "@fluentui/react-icons";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import { ProjectArtifactsView } from "@/components/cleanup/ProjectArtifactsView";
import { AiAndToolchainsView } from "@/components/cleanup/AiAndToolchainsView";
import { describeDisposal } from "@/utils/disposal";

interface RuleScanCandidate {
  path: string;
  size_bytes: number;
  is_dir: boolean;
  rule_id: string;
  rule_name: string;
  category: string;
  risk: string;
  verified_rebuildable: boolean;
  default_action: string;
  protect_subpaths: string[];
}

interface RuleScanSummary {
  rule_id: string;
  rule_name: string;
  category: string;
  risk: string;
  verified_rebuildable: boolean;
  default_action: string;
  default_selected: boolean;
  total_bytes: number;
  total_items: number;
  candidates: RuleScanCandidate[];
  is_locked_by_process?: boolean;
  locking_process_name?: string;
}

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

  const handleScan = async () => {
    setScanning(true);
    setLastDisposal(null);
    try {
      const results = await invoke<RuleScanSummary[]>("scan_cleanup_rules");
      setSummaries(results);
      const autoSelected = new Set<string>();
      results.forEach((r) => {
        if (r.default_selected && (r.candidates.length > 0 || r.total_bytes > 0)) {
          autoSelected.add(r.rule_id);
        }
      });
      setSelectedRuleIds(autoSelected);
    } catch (e) {
      console.error("Scan failed:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    handleScan();
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

  const filteredSummaries = summaries.filter((r) => {
    if (activeCategory === "all") return true;
    return r.category.toLowerCase() === activeCategory.toLowerCase();
  });

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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <Delete24Filled className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
              {t.cleanup.title}
            </h1>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t.cleanup.subtitle}
            </p>
          </div>
        </div>

        {mainTab === "system" && (
          <div className="flex items-center gap-2 shrink-0">
            <WinUIButton
              variant="standard"
              onClick={handleScan}
              disabled={scanning || cleaning}
              icon={<ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />}
            >
              {scanning ? t.common.scanning : t.cleanup.rescan}
            </WinUIButton>
            <WinUIButton
              variant="primary"
              onClick={handleExecuteCleanup}
              disabled={selectedRuleIds.size === 0 || cleaning || scanning}
              icon={<Delete20Regular className="w-3.5 h-3.5" />}
            >
              {cleaning ? t.common.cleaning : `${t.cleanup.cleanNow} (${formatBytes(totalSelectedBytes)})`}
            </WinUIButton>
          </div>
        )}
      </div>

      {/* Primary Section Switcher: System Cleaners vs Developer Projects vs AI & Toolchains */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-2">
        <button
          onClick={() => setMainTab("system")}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
            mainTab === "system"
              ? "bg-[#0078d4] text-white shadow-xs"
              : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
          }`}
        >
          <Delete20Regular className="w-3.5 h-3.5" />
          <span>{t.cleanup.tabSystemCleaners} ({summaries.length})</span>
        </button>
        <button
          onClick={() => setMainTab("projects")}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
            mainTab === "projects"
              ? "bg-[#0078d4] text-white shadow-xs"
              : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
          }`}
        >
          <Code20Regular className="w-3.5 h-3.5" />
          <span>{t.cleanup.tabDeveloperProjects}</span>
        </button>
        <button
          onClick={() => setMainTab("aiAndToolchains")}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
            mainTab === "aiAndToolchains"
              ? "bg-[#0078d4] text-white shadow-xs"
              : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
          }`}
        >
          <Sparkle20Filled className="w-3.5 h-3.5" />
          <span>{t.cleanup.tabAiAndToolchains}</span>
        </button>
      </div>

      {mainTab === "projects" ? (
        <ProjectArtifactsView />
      ) : mainTab === "aiAndToolchains" ? (
        <AiAndToolchainsView />
      ) : (
        <>
          {/* Recent Cleanup Completion Banner */}
      {lastDisposal && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between gap-3 text-xs animate-fadeIn">
          <div className="flex items-center gap-2.5 text-emerald-400">
            <CheckmarkCircle24Filled className="w-5 h-5 text-emerald-400 shrink-0" />
            <span>
              <strong>{t.cleanup.cleanComplete}:</strong> {describeDisposal(lastDisposal, t, formatBytes)} ({lastDisposal.successful_items} {t.common.files}).
            </span>
          </div>
          <button
            onClick={() => setLastDisposal(null)}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-0.5 rounded cursor-pointer transition-colors text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Active Applications Warning & 1-Click Unlock Banner */}
      {lockedActiveApps.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs animate-fadeIn">
          <div className="flex items-center gap-2 text-amber-300">
            <Warning20Filled className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>{lockedActiveApps.length} active application(s)</strong> ({lockedActiveApps.join(", ")}) are currently locking cache directories. Close them for complete cleaning.
            </span>
          </div>
          <button
            onClick={handleCloseAllLockingProcesses}
            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-[4px] cursor-pointer transition-colors shrink-0 text-xs shadow-sm"
          >
            Close All & Unlock Cache
          </button>
        </div>
      )}

      {/* Category Filter Pills & Mode Selection */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5">
          <Filter20Regular className="w-3.5 h-3.5 text-[var(--text-muted)] mr-1 shrink-0" />
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`h-7 px-3 text-xs rounded-[4px] transition-all cursor-pointer ${
                activeCategory === cat
                  ? "bg-[#0078d4] text-white font-semibold shadow-sm"
                  : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]"
              }`}
            >
              {getCategoryLabel(cat)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={selectSmart}
            className="text-[var(--text-secondary)] hover:text-[#0078d4] transition-colors flex items-center gap-1.5 cursor-pointer font-medium px-2 py-1 rounded-[4px] hover:bg-white/[0.04]"
          >
            <Sparkle20Filled className="w-3.5 h-3.5 text-[#0078d4]" />
            <span>{t.cleanup.smartSelect}</span>
          </button>
          <span className="text-[var(--border-divider)]">•</span>
          <button
            onClick={selectAll}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer font-medium px-2 py-1 rounded-[4px] hover:bg-white/[0.04]"
          >
            {t.cleanup.selectAll}
          </button>
          <span className="text-[var(--border-divider)]">•</span>
          <button
            onClick={clearSelection}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer font-medium px-2 py-1 rounded-[4px] hover:bg-white/[0.04]"
          >
            {t.cleanup.clear}
          </button>
        </div>
      </div>

      {/* Disposal Summary Banner if completed */}
      {lastDisposal && (
        <WinUICard className="p-4 space-y-3 animate-fadeIn">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
              <CheckmarkCircle24Filled className="w-4 h-4 text-emerald-400" />
              <span>{t.cleanup.cleanComplete}</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)] font-ibm-mono">
              Session: {lastDisposal.session_id.substring(0, 8)}...
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-ibm-mono">
            <div className="p-2.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)]">
              <div className="text-[11px] text-[var(--text-muted)] font-sans">{t.cleanup.reclaimedSpace}</div>
              <div className="text-lg font-bold text-emerald-400 mt-0.5 tabular-nums">
                {formatBytes(lastDisposal.total_freed_bytes)}
              </div>
            </div>
            <div className="p-2.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)]">
              <div className="text-[11px] text-[var(--text-muted)] font-sans">{t.cleanup.movedToRecycleBin}</div>
              <div className="text-lg font-bold text-[var(--text-primary)] mt-0.5 tabular-nums">
                {formatBytes(lastDisposal.recycled_bytes ?? 0)}
              </div>
            </div>
            <div className="p-2.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)]">
              <div className="text-[11px] text-[var(--text-muted)] font-sans">{t.cleanup.filesCleaned}</div>
              <div className="text-lg font-bold text-[var(--text-primary)] mt-0.5 tabular-nums">
                {lastDisposal.successful_items} / {lastDisposal.total_requested_items}
              </div>
            </div>
            <div className="p-2.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)]">
              <div className="text-[11px] text-[var(--text-muted)] font-sans">{t.cleanup.failedTrash}</div>
              <div
                className={`text-lg font-bold mt-0.5 tabular-nums ${
                  lastDisposal.failed_items > 0 ? "text-amber-400" : "text-emerald-400"
                }`}
              >
                {lastDisposal.failed_items}
              </div>
            </div>
          </div>
        </WinUICard>
      )}

      {/* Rules Dense Inspection List */}
      <WinUICard>
        {scanning ? (
          <div className="p-4">
            <LiveScanProgressWidget scanType="cleanup" title={t.cleanup.scanningFiles} />
          </div>
        ) : cleaning ? (
          <div className="p-4">
            <LiveScanProgressWidget scanType="disposal" title={t.common.cleaning} showCancel={false} />
          </div>
        ) : filteredSummaries.length === 0 ? (
          <div className="p-10 text-center space-y-1.5">
            <CheckmarkCircle24Filled className="w-6 h-6 text-emerald-400 mx-auto" />
            <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.cleanup.allCleanTitle}</h3>
            <p className="text-xs text-[var(--text-secondary)]">{t.cleanup.allCleanDesc}</p>
          </div>
        ) : (
          filteredSummaries.map((rule) => {
            const isSelected = selectedRuleIds.has(rule.rule_id);
            const isExpanded = expandedRules.has(rule.rule_id);
            const hasCandidates = rule.candidates.length > 0 || rule.total_bytes > 0;

            return (
              <div key={rule.rule_id} className="border-t border-[var(--border-divider)] first:border-t-0">
                {/* Rule Item Row */}
                <div className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <button
                      onClick={() => toggleSelectRule(rule.rule_id)}
                      disabled={!hasCandidates}
                      className="text-[var(--text-muted)] hover:text-[#0078d4] transition-colors disabled:opacity-30 cursor-pointer p-0.5"
                    >
                      {isSelected ? (
                        <CheckboxChecked20Filled className="w-5 h-5 text-[#0078d4]" />
                      ) : (
                        <CheckboxUnchecked20Regular className="w-5 h-5 text-[var(--text-muted)]" />
                      )}
                    </button>

                    <button
                      onClick={() => toggleExpandRule(rule.rule_id)}
                      className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer p-0.5"
                    >
                      {isExpanded ? (
                        <ChevronDown16Regular className="w-4 h-4 text-[#0078d4]" />
                      ) : (
                        <ChevronRight16Regular className="w-4 h-4" />
                      )}
                    </button>

                    <div
                      className="min-w-0 flex-1 cursor-pointer"
                      onClick={() => toggleExpandRule(rule.rule_id)}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-[var(--text-primary)] text-[13px] tracking-tight truncate">
                          {rule.rule_name}
                        </span>
                        <span className="px-1.5 py-0.2 rounded-[4px] text-[10px] font-medium border bg-white/[0.04] border-[var(--border-subtle)] text-[var(--text-secondary)]">
                          {getCategoryLabel(rule.category)}
                        </span>
                        <span
                          className={`px-1.5 py-0.2 rounded-[4px] text-[9px] font-semibold ${
                            rule.risk === "safe"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : rule.risk === "low"
                              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          }`}
                        >
                          {rule.risk === "safe" ? t.cleanup.safeToClean : rule.risk === "low" ? t.cleanup.lowRisk : t.cleanup.devBuildCache}
                        </span>
                        {rule.is_locked_by_process && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-[4px] text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            <DismissCircle20Regular className="w-2.5 h-2.5 text-amber-400 inline" />
                            App Active ({rule.locking_process_name})
                          </span>
                        )}
                        {rule.is_locked_by_process && rule.locking_process_name && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCloseProcess(rule.locking_process_name!);
                            }}
                            className="px-2 py-0.5 text-[9px] font-semibold rounded-[4px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 cursor-pointer transition-colors"
                            title={`Close ${rule.locking_process_name} to unlock cache`}
                          >
                            Close App & Unlock
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                        {rule.default_action === "trash" ? t.cleanup.routesRecycleBin : t.cleanup.safeCleanupAction}
                      </p>
                    </div>
                  </div>

                  {/* Size & Items */}
                  <div className="flex items-center gap-3 shrink-0 font-ibm-mono text-right tabular-nums">
                    <div>
                      <div className="text-xs font-semibold text-[var(--text-primary)]">
                        {formatBytes(rule.total_bytes)}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {rule.total_items} {t.common.items}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Candidate Sub-list if expanded */}
                {isExpanded && (
                  <div className="border-t border-[var(--border-divider)] bg-black/20 p-3 space-y-1.5 max-h-60 overflow-y-auto scrollbar-thin">
                    <div className="flex items-center justify-between text-[10px] font-ibm-mono text-[var(--text-muted)] uppercase mb-1">
                      <span>{t.cleanup.matchingFiles} ({rule.candidates.length > 0 ? rule.candidates.length : rule.total_items})</span>
                      {rule.total_items > rule.candidates.length && rule.candidates.length > 0 && (
                        <span className="text-[#0078d4] normal-case font-ibm-mono">
                          {t.cleanup.previewNotice} ({rule.candidates.length}/{rule.total_items})
                        </span>
                      )}
                    </div>
                    {rule.candidates.length === 0 ? (
                      <div className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-[4px] bg-white/[0.02] border border-[var(--border-subtle)] font-ibm-mono">
                        <div className="flex items-center gap-2 truncate text-[var(--text-secondary)]">
                          <Folder20Regular className="w-3.5 h-3.5 text-[#0078d4] shrink-0" />
                          <span className="truncate text-[11px]">
                            {rule.rule_id === "windows_recycle_bin"
                              ? `Windows Recycle Bin items (${rule.total_items} items)`
                              : `${rule.rule_name} system cache files (${rule.total_items} items)`}
                          </span>
                        </div>
                        <span className="text-[var(--text-primary)] font-medium shrink-0 ml-4 tabular-nums">
                          {formatBytes(rule.total_bytes)}
                        </span>
                      </div>
                    ) : (
                      rule.candidates.map((cand, cIdx) => (
                        <div
                          key={cIdx}
                          className="flex items-center justify-between text-xs py-1 px-2.5 rounded-[4px] bg-white/[0.02] border border-[var(--border-subtle)] font-ibm-mono"
                        >
                          <div className="flex items-center gap-2 truncate text-[var(--text-secondary)]">
                            {cand.is_dir ? (
                              <Folder20Regular className="w-3.5 h-3.5 text-[#0078d4] shrink-0" />
                            ) : (
                              <Document20Regular className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                            )}
                            <span className="truncate text-[11px] select-all">{cand.path}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-4">
                            <span className="text-[var(--text-primary)] font-medium tabular-nums">
                              {formatBytes(cand.size_bytes)}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                revealItemInDir(cand.path).catch((err) => console.warn("Failed to reveal item in Explorer:", err));
                              }}
                              className="text-[var(--text-muted)] hover:text-[#0078d4] p-1 rounded transition-colors"
                              title="Open location in Explorer"
                            >
                              <FolderOpen16Regular className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </WinUICard>

      {/* Floating Bottom Selection Action Bar (WinUI 3 CommandBar) */}
      {selectedRuleIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 max-w-2xl w-[90%] bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg shadow-2xl p-3 flex items-center justify-between gap-4 z-40 animate-slideUp">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[4px] bg-[#0078d4]/10 text-[#0078d4] flex items-center justify-center shrink-0">
              <Delete20Regular className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                {selectedRuleIds.size} {t.cleanup.itemsSelected} (<strong className="font-ibm-mono tabular-nums">{totalSelectedItems}</strong> {t.common.files})
              </div>
              <div className="text-[11px] text-[var(--text-muted)] font-ibm-mono">
                {t.cleanup.estimatedSpace}: <strong className="text-emerald-400 tabular-nums">{formatBytes(totalSelectedBytes)}</strong>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <WinUIButton
              variant="subtle"
              size="sm"
              onClick={clearSelection}
            >
              {t.common.deselectAll}
            </WinUIButton>
            <WinUIButton
              variant="primary"
              size="md"
              onClick={() => {
                if (confirmBeforeDelete) {
                  setShowConfirmModal(true);
                } else {
                  handleExecuteCleanup();
                }
              }}
              disabled={cleaning || scanning || selectedRuleIds.size === 0}
              icon={<Delete20Regular className="w-4 h-4" />}
            >
              {cleaning ? t.common.cleaning : `${t.cleanup.cleanNow} (${formatBytes(totalSelectedBytes)})`}
            </WinUIButton>
          </div>
        </div>
      )}
        </>
      )}

      {/* Safety Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="max-w-lg w-full p-6 shadow-2xl space-y-4 border border-[var(--border-card)] bg-[var(--bg-card)] rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[4px] bg-[#0078d4]/15 border border-[#0078d4]/30 flex items-center justify-center text-[#0078d4] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                  {t.settings.confirmDelete}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Clean {selectedRuleIds.size} rule category(s) and free approx{" "}
                  <span className="font-bold text-emerald-400 font-ibm-mono">
                    {formatBytes(totalSelectedBytes)}
                  </span>
                  .
                </p>
              </div>
            </div>

            <div className="p-3 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] text-xs space-y-2 font-sans">
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>{t.cleanup.itemsSelected}:</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-bold">{selectedRuleIds.size}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>{t.cleanup.filesCleaned}:</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-bold">{totalSelectedItems.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Safety route:</span>
                <span className={`font-ibm-mono font-semibold ${alwaysTrashOverride ? "text-emerald-400" : "text-amber-400"}`}>
                  {alwaysTrashOverride ? "Recycle Bin (Safe)" : "Immediate Purge"}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-divider)]">
              <WinUIButton
                variant="standard"
                onClick={() => setShowConfirmModal(false)}
                disabled={cleaning}
              >
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
          </div>
        </div>
      )}

      {/* Manual Conflict Modal for Failed Trash Deletions */}
      {manualConflictPath && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="max-w-lg w-full p-6 shadow-2xl space-y-4 border border-[var(--border-card)] bg-[var(--bg-card)] rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-[4px] bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                <Warning20Filled className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                  {t.cleanup.trashFailedTitle}
                  {failedTotal > 1 && (
                    <span className="ml-2 font-ibm-mono text-xs text-[var(--text-muted)]">
                      {failedTotal - failedQueue.length + 1} / {failedTotal}
                    </span>
                  )}
                </h3>

                <p className="text-xs text-[var(--text-secondary)]">{t.cleanup.trashFailedDesc}</p>
              </div>
            </div>

            <div className="p-2.5 rounded-[4px] bg-black/20 border border-[var(--border-subtle)] font-ibm-mono text-xs text-[var(--text-secondary)] break-all select-all">
              {manualConflictPath}
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {t.cleanup.trashFailedHelp}
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-divider)]">
              <WinUIButton
                variant="standard"
                onClick={resolveCurrentConflict}
                disabled={resolvingPath}
              >
                {t.cleanup.keepFileAction}
              </WinUIButton>
              <WinUIButton
                variant="standard"
                onClick={() => handleRetryTrash(manualConflictPath)}
                disabled={resolvingPath}
              >
                {t.cleanup.retryTrash}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={() => handleForceDelete(manualConflictPath)}
                disabled={resolvingPath}
              >
                {t.cleanup.permanentDeleteAction}
              </WinUIButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CleanupPage;
