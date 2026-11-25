import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import {
  DocumentCopy24Filled,
  Delete20Regular,
  ArrowClockwise20Regular,
  Link20Regular,
  Document20Regular,
  CheckmarkCircle20Filled,
  Checkmark16Filled,
  Search20Regular,
  Layer20Regular,
  HardDrive20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  FolderOpen20Regular,
  Folder20Regular,
  Sparkle20Filled,
} from "@fluentui/react-icons";

interface StorageVolumeInfo {
  mount_point: string;
  volume_name: string;
  total_bytes: number;
  available_bytes: number;
  file_system: string;
  is_removable: boolean;
}

interface DuplicateFileEntry {
  path: string;
  size_bytes: number;
  modified_at: number;
  device_id: number;
  file_index: number;
  is_hardlink_or_clone: boolean;
  selected: boolean;
}

interface DuplicateGroup {
  group_id: string;
  hash: string;
  file_size: number;
  files: DuplicateFileEntry[];
  potential_savings_bytes: number;
}

interface DuplicateFolderEntry {
  path: string;
  file_count: number;
  total_size_bytes: number;
  selected: boolean;
}

interface DuplicateFolderGroup {
  group_id: string;
  folder_hash: string;
  directories: DuplicateFolderEntry[];
  total_files: number;
  folder_size_bytes: number;
  potential_savings_bytes: number;
}

interface DuplicateScanResult {
  total_groups: number;
  total_folder_groups?: number;
  total_duplicate_files: number;
  total_potential_savings: number;
  groups: DuplicateGroup[];
  folder_groups?: DuplicateFolderGroup[];
  cache_hits?: number;
  scan_duration_ms?: number;
}

interface DisposalSummary {
  session_id: string;
  total_requested_items: number;
  successful_items: number;
  failed_items: number;
  total_freed_bytes: number;
  failed_trash_paths: string[];
}

export const DuplicatesPage: React.FC = () => {
  const { t } = useI18nStore();
  const { confirmBeforeDelete } = useSettingsStore();
  const [volumes, setVolumes] = useState<StorageVolumeInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [scanResult, setScanResult] = useState<DuplicateScanResult | null>(null);
  const [disposalSummary, setDisposalSummary] = useState<DisposalSummary | null>(null);
  const [selectedDrive, setSelectedDrive] = useState<string>("ALL");
  const [minSizeKb, setMinSizeKb] = useState<number>(10240); // 10 MB safe default
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [hideHardlinks, setHideHardlinks] = useState<boolean>(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"files" | "folders">("files");
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const handleScan = async (targetDrive = selectedDrive, minKb = minSizeKb) => {
    setScanning(true);
    setDisposalSummary(null);
    try {
      const rootsToScan =
        targetDrive === "ALL"
          ? (volumes.length > 0 ? volumes.map((v) => v.mount_point) : ["C:\\"])
          : [targetDrive];

      const res = await invoke<DuplicateScanResult>("scan_duplicate_files", {
        roots: rootsToScan,
        minSizeBytes: minKb * 1024,
      });
      setScanResult(res);
      // Expand all groups by default
      const allIds = new Set(res.groups.map((g) => g.group_id));
      setExpandedGroups(allIds);
    } catch (e: any) {
      const errStr = String(e || "");
      if (errStr.toLowerCase().includes("cancel") || errStr.toLowerCase().includes("aborted")) {
        // Cancelled cleanly by user
      } else {
        console.error("Duplicate scan failed:", e);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    try {
      await invoke("cancel_active_scan");
      setScanning(false);
    } catch (e) {
      console.error("Failed to cancel scan:", e);
    }
  };

  useEffect(() => {
    const loadVolumes = async () => {
      try {
        const vols = await invoke<StorageVolumeInfo[]>("get_storage_volumes");
        if (vols && vols.length > 0) {
          setVolumes(vols);
        }
      } catch (e) {
        console.error("Failed to load storage volumes:", e);
      }
    };
    loadVolumes();
  }, []);

  const toggleSelectFile = (groupId: string, path: string) => {
    if (!scanResult) return;
    const nextGroups = scanResult.groups.map((group) => {
      if (group.group_id !== groupId) return group;
      return {
        ...group,
        files: group.files.map((file) => {
          if (file.path !== path) return file;
          return { ...file, selected: !file.selected };
        }),
      };
    });
    setScanResult({ ...scanResult, groups: nextGroups });
  };

  const applyHeuristic = (heuristic: "oldest" | "newest" | "shortest" | "all-except-first" | "none") => {
    if (!scanResult) return;
    const nextGroups = scanResult.groups.map((group) => {
      if (heuristic === "none") {
        return {
          ...group,
          files: group.files.map((f) => ({ ...f, selected: false })),
        };
      }

      if (group.files.length <= 1) return group;

      let keepIndex = 0;
      if (heuristic === "oldest") {
        let oldestTime = group.files[0].modified_at;
        group.files.forEach((f, idx) => {
          if (f.modified_at < oldestTime) {
            oldestTime = f.modified_at;
            keepIndex = idx;
          }
        });
      } else if (heuristic === "newest") {
        let newestTime = group.files[0].modified_at;
        group.files.forEach((f, idx) => {
          if (f.modified_at > newestTime) {
            newestTime = f.modified_at;
            keepIndex = idx;
          }
        });
      } else if (heuristic === "shortest") {
        let shortestLen = group.files[0].path.length;
        group.files.forEach((f, idx) => {
          if (f.path.length < shortestLen) {
            shortestLen = f.path.length;
            keepIndex = idx;
          }
        });
      } else if (heuristic === "all-except-first") {
        keepIndex = 0;
      }

      return {
        ...group,
        files: group.files.map((f, idx) => ({
          ...f,
          selected: idx !== keepIndex && !f.is_hardlink_or_clone,
        })),
      };
    });

    setScanResult({ ...scanResult, groups: nextGroups });
  };

  const handleTrashSelected = async () => {
    if (!scanResult) return;
    const selectedPaths: string[] = [];
    scanResult.groups.forEach((g) => {
      g.files.forEach((f) => {
        if (f.selected) selectedPaths.push(f.path);
      });
    });

    if (selectedPaths.length === 0) return;

    setTrashing(true);
    try {
      const summary = await invoke<DisposalSummary>("trash_duplicate_files", {
        paths: selectedPaths,
      });
      setDisposalSummary(summary);

      const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const failedSet = new Set((summary.failed_trash_paths || []).map(normalize));
      const successfulSet = new Set(selectedPaths.filter((p) => !failedSet.has(normalize(p))).map(normalize));
      const nextGroups = scanResult.groups
        .map((group) => {
          const remainingFiles = group.files.filter((f) => !successfulSet.has(normalize(f.path)));
          return {
            ...group,
            files: remainingFiles,
            potential_savings_bytes: Math.max(0, (remainingFiles.length - 1) * group.file_size),
          };
        })
        .filter((g) => g.files.length > 1);

      setScanResult({
        ...scanResult,
        total_groups: nextGroups.length,
        total_duplicate_files: nextGroups.reduce((acc, g) => acc + g.files.length, 0),
        total_potential_savings: nextGroups.reduce((acc, g) => acc + g.potential_savings_bytes, 0),
        groups: nextGroups,
      });

      toast.success(
        "Duplicates Recycled",
        `Safely moved ${summary.successful_items} duplicate file(s) to Recycle Bin (${formatBytes(summary.total_freed_bytes)} reclaimed).`
      );
    } catch (e) {
      console.error("Failed to trash duplicate files:", e);
      toast.error("Trashing Failed", String(e));
    } finally {
      setTrashing(false);
    }
  };

  const handleTrashFolders = async (foldersToTrash?: string[]) => {
    if (!scanResult || !scanResult.folder_groups) return;
    const paths = foldersToTrash || scanResult.folder_groups.flatMap((g) =>
      g.directories.filter((d) => d.selected).map((d) => d.path)
    );
    if (paths.length === 0) return;

    setTrashing(true);
    try {
      const summary = await invoke<DisposalSummary>("trash_duplicate_folders", {
        folderPaths: paths,
      });
      setDisposalSummary(summary);
      toast.success(
        "Folders Recycled",
        `Safely moved ${summary.successful_items} duplicate folder(s) to Recycle Bin.`
      );
      handleScan();
    } catch (e) {
      console.error("Folder trash failed:", e);
      toast.error("Folder Trashing Failed", String(e));
    } finally {
      setTrashing(false);
    }
  };

  const toggleSelectFolder = (groupId: string, folderPath: string) => {
    if (!scanResult || !scanResult.folder_groups) return;
    const nextGroups = scanResult.folder_groups.map((g) => {
      if (g.group_id !== groupId) return g;
      return {
        ...g,
        directories: g.directories.map((d) => {
          if (d.path !== folderPath) return d;
          return { ...d, selected: !d.selected };
        }),
      };
    });
    setScanResult({ ...scanResult, folder_groups: nextGroups });
  };

  const handleRevealInExplorer = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (e) {
      console.error("Failed to reveal item in explorer:", e);
    }
  };

  const toggleGroupExpand = (groupId: string) => {
    const next = new Set(expandedGroups);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    setExpandedGroups(next);
  };

  // Filter groups
  const filteredGroups = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.groups.filter((group) => {
      if (hideHardlinks && group.potential_savings_bytes === 0) return false;
      if (!searchFilter) return true;
      const q = searchFilter.toLowerCase();
      return (
        group.hash.toLowerCase().includes(q) ||
        group.files.some((f) => f.path.toLowerCase().includes(q))
      );
    });
  }, [scanResult, hideHardlinks, searchFilter]);

  const totalSelectedCount = scanResult
    ? scanResult.groups.flatMap((g) => g.files).filter((f) => f.selected).length
    : 0;

  const totalSelectedBytes = scanResult
    ? scanResult.groups.reduce((acc, g) => {
        const selectedInGroup = g.files.filter((f) => f.selected).length;
        if (selectedInGroup === 0 || g.potential_savings_bytes === 0) return acc;
        return acc + g.file_size * selectedInGroup;
      }, 0)
    : 0;

  const totalHardlinkGroups = scanResult
    ? scanResult.groups.filter((g) => g.potential_savings_bytes === 0).length
    : 0;

  const scanTargetLabel =
    selectedDrive === "ALL"
      ? `All Drives (${volumes.length > 0 ? volumes.map((v) => v.mount_point).join(", ") : "All"})`
      : selectedDrive;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <DocumentCopy24Filled className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.duplicates.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] text-[10px] font-ibm-mono uppercase tracking-wider bg-[#0078d4]/10 text-[#0078d4] border border-[#0078d4]/20">
                {t.duplicates.exactMatchBadge}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.duplicates.subtitle}
            </p>
          </div>
        </div>

        {/* Quick scan controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 bg-black/20 px-2.5 py-1 rounded-[4px] border border-[var(--border-card)]">
            <span className="text-[11px] text-[var(--text-secondary)] font-medium">{t.duplicates.minSize}</span>
            <select
              value={minSizeKb}
              disabled={scanning || trashing}
              onChange={(e) => {
                const val = Number(e.target.value);
                setMinSizeKb(val);
                handleScan(selectedDrive, val);
              }}
              className="bg-transparent text-[var(--text-primary)] text-xs font-ibm-mono font-semibold focus:outline-none cursor-pointer disabled:opacity-50"
            >
              <option value={1} className="bg-[#202020] text-[var(--text-primary)]">≥ 1 KB</option>
              <option value={10} className="bg-[#202020] text-[var(--text-primary)]">≥ 10 KB</option>
              <option value={1024} className="bg-[#202020] text-[var(--text-primary)]">≥ 1 MB</option>
              <option value={10240} className="bg-[#202020] text-[var(--text-primary)]">≥ 10 MB</option>
              <option value={102400} className="bg-[#202020] text-[var(--text-primary)]">≥ 100 MB</option>
            </select>
          </div>

          <WinUIButton
            variant="primary"
            onClick={() => handleScan()}
            disabled={scanning || trashing}
            className="flex items-center gap-1.5"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
            <span>{scanning ? t.common.scanning : t.common.rescan}</span>
          </WinUIButton>

          {totalSelectedCount > 0 && (
            <WinUIButton
              variant="danger"
              onClick={() => {
                if (confirmBeforeDelete) {
                  setShowConfirmModal(true);
                } else {
                  handleTrashSelected();
                }
              }}
              disabled={trashing || scanning}
              className="flex items-center gap-1.5"
            >
              <Delete20Regular className="w-3.5 h-3.5" />
              <span>{trashing ? t.duplicates.trashingProgress : `${t.duplicates.trashSelected} (${totalSelectedCount}) • ${formatBytes(totalSelectedBytes)}`}</span>
            </WinUIButton>
          )}
        </div>
      </div>

      {/* Drive Selection Pills */}
      {volumes.length > 0 && (
        <WinUICard className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
            <HardDrive20Regular className="w-4 h-4 text-[#0078d4]" />
            <span>{t.duplicates.selectDrive}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setSelectedDrive("ALL");
                handleScan("ALL", minSizeKb);
              }}
              disabled={scanning || trashing}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-[4px] text-xs transition-all ${
                scanning || trashing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
              } ${
                selectedDrive === "ALL"
                  ? "bg-[#0078d4] text-white shadow-xs"
                  : "bg-black/20 hover:bg-white/[0.05] text-[var(--text-primary)] border border-[var(--border-card)]"
              }`}
            >
              <HardDrive20Regular className="w-3.5 h-3.5" />
              <span className="font-semibold">All Drives</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-[3px] font-ibm-mono tabular-nums ${
                  selectedDrive === "ALL" ? "bg-white/20 text-white" : "bg-black/30 text-[var(--text-secondary)]"
                }`}
              >
                {volumes.length}
              </span>
            </button>

            {volumes.map((vol) => {
              const isSelected = selectedDrive === vol.mount_point;
              const freeGb = (vol.available_bytes / (1024 * 1024 * 1024)).toFixed(1);
              const totalGb = (vol.total_bytes / (1024 * 1024 * 1024)).toFixed(1);

              return (
                <button
                  key={vol.mount_point}
                  onClick={() => {
                    setSelectedDrive(vol.mount_point);
                    handleScan(vol.mount_point, minSizeKb);
                  }}
                  disabled={scanning || trashing}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-[4px] text-xs transition-all ${
                    scanning || trashing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                  } ${
                    isSelected
                      ? "bg-[#0078d4] text-white shadow-xs"
                      : "bg-black/20 hover:bg-white/[0.05] text-[var(--text-primary)] border border-[var(--border-card)]"
                  }`}
                >
                  <span className="font-ibm-mono font-bold">{vol.mount_point}</span>
                  <span className="text-[11px] opacity-80">{vol.volume_name || t.common.drive}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-[3px] font-ibm-mono tabular-nums ${
                      isSelected ? "bg-white/20 text-white" : "bg-black/30 text-[var(--text-secondary)]"
                    }`}
                  >
                    {freeGb} GB / {totalGb} GB
                  </span>
                </button>
              );
            })}

            <button
              onClick={() => {
                const custom = prompt(t.duplicates.customPathPrompt, selectedDrive === "ALL" ? "C:\\" : selectedDrive);
                if (custom && custom.trim()) {
                  setSelectedDrive(custom.trim());
                  handleScan(custom.trim(), minSizeKb);
                }
              }}
              disabled={scanning || trashing}
              className={`px-3 py-1.5 rounded-[4px] text-xs font-medium bg-black/20 hover:bg-white/[0.05] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)] transition-all flex items-center gap-1.5 ${
                scanning || trashing ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
              }`}
            >
              <Folder20Regular className="w-3.5 h-3.5" />
              <span>{t.common.showInFolder}...</span>
            </button>
          </div>
        </WinUICard>
      )}

      {/* Disposal Summary Notification */}
      {disposalSummary && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
            <div>
              <div className="text-xs font-semibold text-emerald-400">
                {t.cleanup.cleanComplete}
              </div>
              <div className="text-[11px] text-emerald-400/80 font-ibm-mono tabular-nums">
                {disposalSummary.successful_items} {t.common.files} • {t.cleanup.reclaimedSpace}: {formatBytes(disposalSummary.total_freed_bytes)}
              </div>
            </div>
          </div>
          <button
            onClick={() => setDisposalSummary(null)}
            className="text-xs text-emerald-400 hover:text-white px-2 py-0.5 rounded-[3px] bg-emerald-500/20 font-medium cursor-pointer"
          >
            {t.common.dismiss}
          </button>
        </div>
      )}

      {/* 4-Tile Stat Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.duplicates.duplicateSets}</span>
            <Layer20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
          </div>
          <div className="text-xl font-bold text-[var(--text-primary)] font-ibm-mono tabular-nums">
            {scanResult ? scanResult.total_groups.toLocaleString() : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono tabular-nums mt-1">
            {filteredGroups.length} {t.common.all}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.common.files}</span>
            <DocumentCopy24Filled className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-xl font-bold text-indigo-400 font-ibm-mono tabular-nums">
            {scanResult ? scanResult.total_duplicate_files.toLocaleString() : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono tabular-nums mt-1">
            {totalSelectedCount} {t.cleanup.itemsSelected}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.duplicates.potentialSavings}</span>
            <HardDrive20Regular className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-emerald-400 font-ibm-mono tabular-nums">
            {scanResult ? formatBytes(scanResult.total_potential_savings) : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono truncate mt-1">
            {scanTargetLabel}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.duplicates.hideHardlinks}</span>
            <Link20Regular className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-xl font-bold text-amber-400 font-ibm-mono tabular-nums">
            {totalHardlinkGroups}
          </div>
          <div className="text-[10px] text-amber-400/80 font-ibm-mono mt-1">
            0 B (NTFS)
          </div>
        </WinUICard>
      </div>

      {/* Instant Hash Cache Acceleration Banner */}
      {scanResult && scanResult.cache_hits !== undefined && scanResult.cache_hits > 0 && (
        <div className="p-3 bg-[#0078d4]/10 border border-[#0078d4]/30 rounded-[4px] flex items-center justify-between text-xs text-blue-300">
          <div className="flex items-center gap-2">
            <Sparkle20Filled className="w-4 h-4 text-[#0078d4]" />
            <span>
              <strong>⚡ {t.duplicateFolders.instantCacheActive}:</strong> {scanResult.cache_hits.toLocaleString()} {t.common.files} {t.duplicateFolders.cacheHitDesc} ({scanResult.scan_duration_ms || 0}ms).
            </span>
          </div>
        </div>
      )}

      {/* Files vs Folders Tab Switcher */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => setActiveTab("files")}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
            activeTab === "files"
              ? "bg-[#0078d4] text-white shadow-xs"
              : "bg-black/20 text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)]"
          }`}
        >
          <Document20Regular className="w-3.5 h-3.5" />
          <span>{t.duplicateFolders.tabFiles} ({scanResult?.groups.length || 0})</span>
        </button>
        <button
          onClick={() => setActiveTab("folders")}
          className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
            activeTab === "folders"
              ? "bg-[#0078d4] text-white shadow-xs"
              : "bg-black/20 text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)]"
          }`}
        >
          <Folder20Regular className="w-3.5 h-3.5" />
          <span>{t.duplicateFolders.tabFolders} ({scanResult?.folder_groups?.length || 0})</span>
        </button>
      </div>

      {/* Controls & Quick Select Bar (for Files tab) */}
      {activeTab === "files" && (
        <WinUICard className="p-3 flex flex-col lg:flex-row items-center justify-between gap-3">
        {/* Search */}
        <div className="relative w-full lg:w-72">
          <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder={t.duplicates.searchPlaceholder}
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#0078d4]"
          />
        </div>

        {/* Heuristic Presets */}
        <div className="flex flex-wrap items-center gap-1.5 w-full lg:w-auto">
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t.duplicates.autoSelectRules}</span>
          <button
            onClick={() => applyHeuristic("oldest")}
            className="px-2.5 py-1 bg-black/20 hover:bg-white/[0.05] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-[4px] text-xs font-medium transition-all cursor-pointer border border-[var(--border-card)]"
          >
            {t.duplicates.keepOldest}
          </button>
          <button
            onClick={() => applyHeuristic("newest")}
            className="px-2.5 py-1 bg-black/20 hover:bg-white/[0.05] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-[4px] text-xs font-medium transition-all cursor-pointer border border-[var(--border-card)]"
          >
            {t.duplicates.keepNewest}
          </button>
          <button
            onClick={() => applyHeuristic("shortest")}
            className="px-2.5 py-1 bg-black/20 hover:bg-white/[0.05] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-[4px] text-xs font-medium transition-all cursor-pointer border border-[var(--border-card)]"
          >
            {t.duplicates.keepShortestPath}
          </button>
          <button
            onClick={() => applyHeuristic("all-except-first")}
            className="px-2.5 py-1 bg-[#0078d4] text-white rounded-[4px] text-xs font-medium transition-all cursor-pointer"
          >
            {t.duplicates.selectAllDuplicates}
          </button>
          <button
            onClick={() => applyHeuristic("none")}
            className="px-2.5 py-1 bg-black/20 hover:bg-white/[0.05] text-[var(--text-muted)] hover:text-[var(--text-secondary)] rounded-[4px] text-xs font-medium transition-all cursor-pointer border border-[var(--border-card)]"
          >
            {t.common.clear}
          </button>

          <div className="h-4 w-px bg-[var(--border-divider)] mx-1" />

          <button
            onClick={() => setHideHardlinks(!hideHardlinks)}
            className={`px-2.5 py-1 rounded-[4px] text-xs font-medium transition-all flex items-center gap-1 cursor-pointer ${
              hideHardlinks
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "bg-black/20 text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-[var(--border-card)]"
            }`}
          >
            <Link20Regular className="w-3 h-3" />
            {hideHardlinks ? t.duplicates.hideHardlinks : t.common.all}
          </button>
        </div>
      </WinUICard>
      )}

      {/* Folders Action Bar (for Folders tab) */}
      {activeTab === "folders" && (
        <WinUICard className="p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <Folder20Regular className="w-4 h-4 text-[#0078d4]" />
            <span>
              {scanResult?.folder_groups?.length || 0} {t.duplicateFolders.foldersFound}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <WinUIButton
              variant="danger"
              onClick={() => handleTrashFolders()}
              disabled={trashing || scanning || !(scanResult?.folder_groups?.some((g) => g.directories.some((d) => d.selected)))}
              className="flex items-center gap-1.5"
            >
              <Delete20Regular className="w-3.5 h-3.5" />
              <span>{trashing ? t.duplicateFolders.recyclingFolders : t.duplicateFolders.recycleSelectedFolders}</span>
            </WinUIButton>
          </div>
        </WinUICard>
      )}

      {/* Duplicate Groups List */}
      {scanning ? (
        <LiveScanProgressWidget
          scanType="duplicates"
          title={t.duplicates.scanning}
          subtitle={`Target: ${scanTargetLabel} • ${t.duplicates.minSize} ≥ ${formatBytes(minSizeKb * 1024)}`}
          onCancel={handleCancelScan}
        />
      ) : trashing ? (
        <LiveScanProgressWidget
          scanType="disposal"
          title="Recycling duplicate items to Recycle Bin..."
          subtitle="Moving duplicate files safely to Windows Recycle Bin"
          showCancel={false}
        />
      ) : !scanResult ? (
        <WinUICard className="p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center mx-auto text-[#0078d4]">
            <DocumentCopy24Filled className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.duplicates.readyTitle} ({scanTargetLabel})</h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
              {t.duplicates.readyDesc}
            </p>
          </div>
          <div className="pt-2">
            <WinUIButton
              variant="primary"
              onClick={() => handleScan()}
              className="inline-flex items-center gap-1.5"
            >
              <Search20Regular className="w-3.5 h-3.5" />
              <span>{t.duplicates.startScan}</span>
            </WinUIButton>
          </div>
        </WinUICard>
      ) : activeTab === "folders" ? (
        scanResult?.folder_groups && scanResult.folder_groups.length > 0 ? (
          <div className="space-y-3">
            {scanResult.folder_groups.map((fGroup) => (
              <WinUICard key={fGroup.group_id} className="overflow-hidden">
                <div className="px-4 py-2.5 bg-black/20 border-b border-[var(--border-divider)] flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Folder20Regular className="w-4 h-4 text-[#0078d4] shrink-0" />
                    <div className="font-ibm-mono text-xs font-semibold text-[var(--text-primary)] truncate">
                      {fGroup.directories.length} {t.duplicateFolders.tabFolders} • {fGroup.total_files} {t.duplicateFolders.identicalFiles}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-ibm-mono font-semibold text-emerald-400">
                      {t.duplicateFolders.potentialSavings}: {formatBytes(fGroup.potential_savings_bytes)}
                    </span>
                  </div>
                </div>

                <div className="p-2 space-y-1.5 bg-black/10">
                  {fGroup.directories.map((dir, dIdx) => (
                    <div
                      key={dir.path}
                      className="flex items-center justify-between p-2 rounded-[4px] hover:bg-white/[0.03] text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          checked={dir.selected}
                          onChange={() => toggleSelectFolder(fGroup.group_id, dir.path)}
                          className="rounded-[3px] accent-[#0078d4] cursor-pointer"
                        />
                        <div className="min-w-0">
                          <div className="font-ibm-mono text-xs text-[var(--text-primary)] truncate font-semibold">
                            {dir.path}
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono">
                            {dir.file_count} {t.common.files} • {formatBytes(dir.total_size_bytes)} {dIdx === 0 ? "• (Original)" : "• (Duplicate)"}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleRevealInExplorer(dir.path)}
                          className="p-1 text-[var(--text-secondary)] hover:text-white rounded-[3px] hover:bg-white/[0.06] transition-colors cursor-pointer"
                          title={t.duplicateFolders.revealInExplorer}
                        >
                          <FolderOpen20Regular className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleTrashFolders([dir.path])}
                          className="px-2 py-0.5 rounded-[3px] bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-[11px] font-medium transition-colors cursor-pointer"
                        >
                          {t.duplicateFolders.recycleFolder}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </WinUICard>
            ))}
          </div>
        ) : (
          <WinUICard className="p-12 text-center space-y-2">
            <Folder20Regular className="w-10 h-10 text-[var(--text-muted)] mx-auto opacity-40" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.duplicateFolders.noFoldersFound}</h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
              {t.duplicateFolders.noFoldersDesc}
            </p>
          </WinUICard>
        )
      ) : filteredGroups.length > 0 ? (
        <div className="space-y-3">
          {filteredGroups.map((group) => {
            const isExpanded = expandedGroups.has(group.group_id);
            const isHardlink = group.potential_savings_bytes === 0;
            const selectedCount = group.files.filter((f) => f.selected).length;

            return (
              <WinUICard
                key={group.group_id}
                className="overflow-hidden"
              >
                {/* Group Header */}
                <div
                  onClick={() => toggleGroupExpand(group.group_id)}
                  className="px-4 py-2.5 bg-black/20 border-b border-[var(--border-divider)] flex items-center justify-between gap-4 cursor-pointer hover:bg-white/[0.02] select-none"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                      {isExpanded ? <ChevronUp16Regular className="w-4 h-4" /> : <ChevronDown16Regular className="w-4 h-4" />}
                    </button>
                    <div className="font-ibm-mono text-xs text-[var(--text-primary)] flex items-center gap-1.5 truncate">
                      <span className="text-[var(--text-muted)] uppercase text-[10px]">Hash:</span>
                      <span className="text-[#0078d4] font-bold tracking-wider">{group.hash.substring(0, 16)}…</span>
                    </div>
                    <span className="text-[11px] px-1.5 py-0.2 rounded-[3px] bg-black/30 border border-[var(--border-card)] text-[var(--text-primary)] font-ibm-mono font-medium tabular-nums">
                      {formatBytes(group.file_size)} / copy
                    </span>
                    <span className="text-[11px] px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-secondary)] font-ibm-mono">
                      {group.files.length} copies
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {isHardlink ? (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[11px] font-ibm-mono font-medium">
                        <Link20Regular className="w-3 h-3 text-amber-400" />
                        {t.duplicates.hardlinkNotice}
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px] font-ibm-mono font-semibold tabular-nums">
                        {t.duplicates.potentialSavings}: {formatBytes(group.potential_savings_bytes)}
                      </span>
                    )}

                    {selectedCount > 0 && (
                      <span className="px-2 py-0.5 rounded-[3px] bg-rose-500/10 text-rose-400 border border-rose-500/20 text-[11px] font-ibm-mono font-bold">
                        {selectedCount} {t.cleanup.itemsSelected}
                      </span>
                    )}
                  </div>
                </div>

                {/* Group Files */}
                {isExpanded && (
                  <div className="divide-y divide-[var(--border-divider)]">
                    {group.files.map((file) => (
                      <div
                        key={file.path}
                        onClick={() => toggleSelectFile(group.group_id, file.path)}
                        className={`px-4 py-2.5 flex items-center justify-between gap-4 cursor-pointer transition-colors ${
                          file.selected
                            ? "bg-rose-500/5 hover:bg-rose-500/10"
                            : "hover:bg-white/[0.02]"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`w-4 h-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors ${
                            file.selected
                              ? "bg-rose-600 border-rose-600 text-white"
                              : "border-[var(--border-subtle)] bg-black/20"
                          }`}>
                            {file.selected && <Checkmark16Filled className="w-3 h-3 text-white" />}
                          </div>
                          <Document20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-ibm-mono text-xs text-[var(--text-primary)] truncate select-all">
                              {file.path}
                            </div>
                            <div className="flex items-center gap-2.5 text-[10px] font-ibm-mono text-[var(--text-secondary)] mt-0.5 tabular-nums">
                              <span>{t.common.date}: {new Date(file.modified_at * 1000).toLocaleString()}</span>
                              {file.is_hardlink_or_clone && (
                                <span className="text-amber-400 font-semibold">
                                  [{t.duplicates.hardlinkNotice}]
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          {/* Reveal in Explorer */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRevealInExplorer(file.path);
                            }}
                            title={t.common.openInExplorer}
                            className="p-1 bg-black/20 hover:bg-[#0078d4] hover:text-white text-[var(--text-secondary)] rounded-[4px] transition-all border border-[var(--border-card)] cursor-pointer"
                          >
                            <FolderOpen20Regular className="w-3.5 h-3.5" />
                          </button>

                          <div className="font-ibm-mono text-xs text-right w-16">
                            <span className={file.selected ? "text-rose-400 font-bold" : "text-[var(--text-muted)] font-medium"}>
                              {file.selected ? t.common.delete.toUpperCase() : t.common.keepFile.toUpperCase()}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </WinUICard>
            );
          })}
        </div>
      ) : (
        <WinUICard className="p-12 text-center space-y-2">
          <DocumentCopy24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.duplicates.noDuplicatesFound}</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.duplicates.noDuplicatesDesc}
          </p>
        </WinUICard>
      )}

      {/* Safety Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="max-w-lg w-full p-6 shadow-2xl space-y-4 border border-[var(--border-card)] bg-[var(--bg-card)] rounded-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[4px] bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                  {t.duplicates.trashConfirm || "Confirm Duplicate File Disposal"}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  Move <span className="font-bold text-rose-400 font-ibm-mono">{totalSelectedCount}</span> duplicate file(s) to Recycle Bin, freeing approx{" "}
                  <span className="font-bold text-emerald-400 font-ibm-mono">
                    {formatBytes(totalSelectedBytes)}
                  </span>
                  .
                </p>
              </div>
            </div>

            <div className="p-3 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] text-xs space-y-2 font-sans">
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Selected duplicate copies:</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-bold">{totalSelectedCount}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Space to reclaim:</span>
                <span className="font-ibm-mono text-emerald-400 font-bold">{formatBytes(totalSelectedBytes)}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Disposal method:</span>
                <span className="font-ibm-mono text-emerald-400 font-semibold">
                  Windows Recycle Bin (Restorable)
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-divider)]">
              <WinUIButton
                variant="standard"
                onClick={() => setShowConfirmModal(false)}
                disabled={trashing}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={() => {
                  setShowConfirmModal(false);
                  handleTrashSelected();
                }}
                disabled={trashing}
              >
                {t.duplicates.trashSelected}
              </WinUIButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DuplicatesPage;
