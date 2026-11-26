import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState, ActionBar } from "@/components/ui";
import {
  DocumentCopy20Regular,
  Delete20Regular,
  ArrowClockwise20Regular,
  Link20Regular,
  CheckmarkCircle20Filled,
  Search20Regular,
  Layer20Regular,
  HardDrive20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  FolderOpen20Regular,
  Folder20Regular,
  Sparkle20Filled,
  Dismiss16Regular,
} from "@fluentui/react-icons";
import { describeDisposal } from "@/utils/disposal";

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
  recycled_bytes?: number;
  failed_trash_paths: string[];
  results: { path: string; success: boolean; error: string | null }[];
}

// Windows-managed files that must never be offered for deletion, even if a
// scan result happens to include them (the backend also filters these out).
const PROTECTED_SYSTEM_FILES = new Set([
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "dumpstack.log",
  "dumpstack.log.tmp",
]);

const isProtectedSystemFile = (path: string): boolean =>
  PROTECTED_SYSTEM_FILES.has((path.split(/[\\/]/).pop() || "").toLowerCase());

/** Short size for drive chips: "21 GB", "1.8 TB". */
const compactBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return "0 GB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
};

/** Drive picker chip. The selected chip gets the accent border. */
const DriveChip: React.FC<{
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}> = ({ selected, disabled, onClick, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`h-9 px-3 rounded-md border text-sm inline-flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
      selected
        ? "border-[var(--accent)] bg-[var(--fill-subtle)] text-[var(--text-primary)]"
        : "border-[var(--border-card)] text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)] cursor-pointer"
    }`}
  >
    {children}
  </button>
);

/** Live progress of a running scan or disposal, fed by the backend progress events. */
const ScanProgressCard: React.FC<{
  scanType: string;
  title: string;
  subtitle?: string;
  cancelLabel?: string;
  onCancel?: () => void;
}> = ({ scanType, title, subtitle, cancelLabel, onCancel }) => {
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

  const percent = Math.max(1, Math.min(100, progress.percent || 1));

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">{progress.stage || title}</div>
          <div className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{subtitle ? `${title} · ${subtitle}` : title}</div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm font-ibm-mono text-[var(--text-secondary)]">{percent}%</span>
          {onCancel && (
            <WinUIButton size="sm" onClick={onCancel} icon={<Dismiss16Regular className="w-4 h-4" />}>
              {cancelLabel}
            </WinUIButton>
          )}
        </div>
      </div>
      <ProgressBar value={percent} />
      <div className="flex items-center justify-between gap-4">
        <div className="font-code text-xs text-[var(--text-muted)] truncate min-w-0" title={progress.currentPath}>
          {progress.currentPath || "…"}
        </div>
        {progress.itemsScanned > 0 && (
          <span className="text-xs font-ibm-mono text-[var(--text-muted)] shrink-0">
            {progress.itemsScanned.toLocaleString()}
          </span>
        )}
      </div>
    </Card>
  );
};

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
      await invoke("cancel_active_scan", { kind: "duplicates" });
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
    const target = scanResult.groups.find((g) => g.group_id === groupId);
    const file = target?.files.find((f) => f.path === path);
    if (file && !file.selected && isProtectedSystemFile(file.path)) return;
    const unselectedLeft = target ? target.files.filter((f) => !f.selected).length : 0;
    if (file && !file.selected && unselectedLeft <= 1) {
      toast.warning(t.duplicates.keepOneCopy);
      return;
    }
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
          selected: idx !== keepIndex && !f.is_hardlink_or_clone && !isProtectedSystemFile(f.path),
        })),
      };
    });

    setScanResult({ ...scanResult, groups: nextGroups });
  };

  const handleTrashSelected = async () => {
    if (!scanResult) return;
    const groupsToTrash = scanResult.groups.filter((g) => g.files.some((f) => f.selected));
    if (groupsToTrash.length === 0) return;

    setTrashing(true);
    try {
      // The backend re-checks every group: one copy is kept and each selected file
      // must still match it byte for byte.
      const summary = await invoke<DisposalSummary>("trash_duplicate_files", {
        groups: groupsToTrash,
      });
      setDisposalSummary(summary);

      const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const successfulSet = new Set(
        summary.results.filter((r) => r.success).map((r) => normalize(r.path))
      );
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

      if (summary.failed_items > 0) {
        toast.warning(
          t.cleanup.trashFailedTitle,
          `${summary.failed_items} / ${summary.total_requested_items}`
        );
      }
      toast.success(
        "Duplicates Recycled",
        `${summary.successful_items} ${t.common.files} · ${describeDisposal(summary, t, formatBytes)}`
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
      ? volumes.length > 0
        ? `${t.common.allDrives} (${volumes.map((v) => v.mount_point.replace(/[\\/]+$/, "")).join(" ")})`
        : t.common.allDrives
      : selectedDrive;

  const folderSelectedCount = scanResult?.folder_groups
    ? scanResult.folder_groups.reduce((acc, g) => acc + g.directories.filter((d) => d.selected).length, 0)
    : 0;

  const requestTrashSelected = () => {
    if (confirmBeforeDelete) {
      setShowConfirmModal(true);
    } else {
      handleTrashSelected();
    }
  };

  const busy = scanning || trashing;

  return (
    <Page className="select-none">
      <PageHeader
        icon={<DocumentCopy20Regular />}
        title={
          <span className="inline-flex items-center gap-3">
            {t.duplicates.title}
            <Badge tone="accent">{t.duplicates.exactMatchBadge}</Badge>
          </span>
        }
        description={t.duplicates.subtitle}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span className="whitespace-nowrap">{t.duplicates.minSize}</span>
              <select
                value={minSizeKb}
                disabled={busy}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMinSizeKb(val);
                  handleScan(selectedDrive, val);
                }}
                className="h-8 px-2 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-primary)] font-ibm-mono focus:outline-none focus:border-[var(--accent)] cursor-pointer disabled:opacity-50"
              >
                <option value={1} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 1 KB</option>
                <option value={10} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 10 KB</option>
                <option value={1024} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 1 MB</option>
                <option value={10240} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 10 MB</option>
                <option value={102400} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 100 MB</option>
              </select>
            </label>
            <WinUIButton
              variant="primary"
              onClick={() => handleScan()}
              disabled={busy}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
            >
              {scanning ? t.common.scanning : scanResult ? t.common.rescan : t.duplicates.scan}
            </WinUIButton>
          </>
        }
      />

      {/* Drive picker */}
      {volumes.length > 0 && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <HardDrive20Regular className="w-4 h-4 text-[var(--text-secondary)]" />
            <span>{t.duplicates.selectDrive}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DriveChip
              selected={selectedDrive === "ALL"}
              disabled={busy}
              onClick={() => {
                setSelectedDrive("ALL");
                handleScan("ALL", minSizeKb);
              }}
            >
              <HardDrive20Regular className="w-4 h-4" />
              <span className="font-medium">{t.common.allDrives}</span>
              <span className="text-xs text-[var(--text-muted)] font-ibm-mono">{volumes.length}</span>
            </DriveChip>

            {volumes.map((vol) => {
              return (
                <DriveChip
                  key={vol.mount_point}
                  selected={selectedDrive === vol.mount_point}
                  disabled={busy}
                  title={vol.volume_name || t.common.drive}
                  onClick={() => {
                    setSelectedDrive(vol.mount_point);
                    handleScan(vol.mount_point, minSizeKb);
                  }}
                >
                  <span className="font-medium font-ibm-mono text-[var(--text-primary)]">
                    {vol.mount_point.replace(/[\\/]+$/, "")}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                    {compactBytes(vol.available_bytes)} {t.common.freeOf} {compactBytes(vol.total_bytes)}
                  </span>
                </DriveChip>
              );
            })}

            <DriveChip
              selected={selectedDrive !== "ALL" && !volumes.some((v) => v.mount_point === selectedDrive)}
              disabled={busy}
              onClick={() => {
                const custom = prompt(t.duplicates.customPathPrompt, selectedDrive === "ALL" ? "C:\\" : selectedDrive);
                if (custom && custom.trim()) {
                  setSelectedDrive(custom.trim());
                  handleScan(custom.trim(), minSizeKb);
                }
              }}
            >
              <Folder20Regular className="w-4 h-4" />
              <span className="max-w-[220px] truncate">
                {selectedDrive !== "ALL" && !volumes.some((v) => v.mount_point === selectedDrive)
                  ? selectedDrive
                  : `${t.common.showInFolder}…`}
              </span>
            </DriveChip>
          </div>
        </Card>
      )}

      {/* Disposal summary */}
      {disposalSummary && (
        <Card className="flex items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <CheckmarkCircle20Filled className="w-5 h-5 text-[var(--success)] shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">{t.cleanup.cleanComplete}</div>
              <div className="text-xs text-[var(--text-secondary)] font-ibm-mono truncate">
                {disposalSummary.successful_items} {t.common.files} · {describeDisposal(disposalSummary, t, formatBytes)}
              </div>
            </div>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setDisposalSummary(null)}>
            {t.common.dismiss}
          </WinUIButton>
        </Card>
      )}

      {scanning ? (
        <ScanProgressCard
          scanType="duplicates"
          title={t.duplicates.scanning}
          subtitle={`${scanTargetLabel} · ${t.duplicates.minSize} ≥ ${formatBytes(minSizeKb * 1024)}`}
          cancelLabel={t.duplicates.cancelScan}
          onCancel={handleCancelScan}
        />
      ) : trashing ? (
        <ScanProgressCard scanType="disposal" title={t.duplicates.recyclingTitle} />
      ) : !scanResult ? (
        <EmptyState
          icon={<DocumentCopy20Regular />}
          title={`${t.duplicates.readyTitle} (${scanTargetLabel})`}
          description={t.duplicates.readyDesc}
          action={
            <WinUIButton variant="primary" onClick={() => handleScan()} icon={<Search20Regular className="w-4 h-4" />}>
              {t.duplicates.startScan}
            </WinUIButton>
          }
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.duplicates.statSets}
              icon={<Layer20Regular />}
              value={scanResult.total_groups.toLocaleString()}
              hint={`${filteredGroups.length} ${t.duplicates.setsShown}`}
            />
            <StatCard
              label={t.duplicates.statFiles}
              icon={<DocumentCopy20Regular />}
              value={scanResult.total_duplicate_files.toLocaleString()}
              hint={`${totalSelectedCount} ${t.duplicates.filesSelected}`}
            />
            <StatCard
              label={t.duplicates.statReclaimable}
              icon={<HardDrive20Regular />}
              tone="success"
              value={formatBytes(scanResult.total_potential_savings)}
              hint={<span title={scanTargetLabel}>{scanTargetLabel}</span>}
            />
            <StatCard
              label={t.duplicates.statHardlinks}
              icon={<Link20Regular />}
              value={totalHardlinkGroups}
              hint={hideHardlinks ? t.duplicates.hardlinksHiddenHint : t.duplicates.hardlinksShownHint}
            />
          </div>

          {/* Hash cache info */}
          {scanResult.cache_hits !== undefined && scanResult.cache_hits > 0 && (
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <Sparkle20Filled className="w-4 h-4 text-[var(--accent-text)] shrink-0" />
              <span>
                <span className="font-medium text-[var(--text-primary)]">{t.duplicateFolders.instantCacheActive}:</span>{" "}
                {scanResult.cache_hits.toLocaleString()} {t.common.files} {t.duplicateFolders.cacheHitDesc} ({scanResult.scan_duration_ms || 0} ms)
              </span>
            </div>
          )}

          <FilterTabs
            items={[
              { id: "files" as const, label: t.duplicates.filesTab, count: scanResult.groups.length },
              { id: "folders" as const, label: t.duplicates.foldersTab, count: scanResult.folder_groups?.length || 0 },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />

          {activeTab === "files" ? (
            <>
              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-56">
                  <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    placeholder={t.duplicates.searchPlaceholder}
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="w-full h-8 pl-8 pr-3 bg-[var(--bg-input)] border border-[var(--border-card)] rounded-md text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <span className="text-sm text-[var(--text-secondary)] ml-1">{t.duplicates.autoSelectRules}</span>
                <WinUIButton size="sm" onClick={() => applyHeuristic("oldest")} title={t.duplicates.keepOldest}>{t.duplicates.ruleOldest}</WinUIButton>
                <WinUIButton size="sm" onClick={() => applyHeuristic("newest")} title={t.duplicates.keepNewest}>{t.duplicates.ruleNewest}</WinUIButton>
                <WinUIButton size="sm" onClick={() => applyHeuristic("shortest")} title={t.duplicates.keepShortestPath}>{t.duplicates.ruleShortest}</WinUIButton>
                <div className="h-5 w-px bg-[var(--border-divider)] mx-1" />
                <WinUIButton size="sm" onClick={() => applyHeuristic("all-except-first")} title={t.duplicates.selectAllDuplicates}>
                  {t.duplicates.selectAll}
                </WinUIButton>
                <WinUIButton size="sm" variant="subtle" onClick={() => applyHeuristic("none")}>{t.common.clear}</WinUIButton>
                <label className="ml-auto inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer" title={t.duplicates.hideHardlinks}>
                  <input
                    type="checkbox"
                    checked={hideHardlinks}
                    onChange={() => setHideHardlinks(!hideHardlinks)}
                    className="accent-[var(--accent)] w-4 h-4 cursor-pointer"
                  />
                  <span>{t.duplicates.hideHardlinksShort}</span>
                </label>
              </div>

              {filteredGroups.length > 0 ? (
                <div className="space-y-3">
                  {filteredGroups.map((group) => {
                    const isExpanded = expandedGroups.has(group.group_id);
                    const isHardlink = group.potential_savings_bytes === 0;
                    const selectedCount = group.files.filter((f) => f.selected).length;
                    const fileName = group.files[0]?.path.split(/[\\/]/).pop() || group.hash;

                    return (
                      <Card key={group.group_id} padded={false} className="overflow-hidden">
                        {/* Set header */}
                        <div
                          onClick={() => toggleGroupExpand(group.group_id)}
                          className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-[var(--fill-subtle)] transition-colors"
                        >
                          <span className="text-[var(--text-secondary)] shrink-0">
                            {isExpanded ? <ChevronUp16Regular className="w-4 h-4" /> : <ChevronDown16Regular className="w-4 h-4" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-semibold text-[var(--text-primary)] truncate" title={fileName}>
                                {fileName}
                              </span>
                              <span className="text-xs text-[var(--text-secondary)] font-ibm-mono whitespace-nowrap">
                                {formatBytes(group.file_size)} {t.duplicates.perCopy} · {group.files.length} {t.duplicates.copies}
                              </span>
                            </div>
                            <div className="text-xs font-code text-[var(--text-muted)] truncate" title={group.hash}>
                              {t.duplicates.hashLabel} {group.hash.substring(0, 16)}…
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {selectedCount > 0 && (
                              <Badge tone="danger">
                                {selectedCount} {t.duplicates.selected}
                              </Badge>
                            )}
                            {isHardlink ? (
                              <Badge tone="warning">
                                <span title={t.duplicates.hardlinkNotice} className="inline-flex items-center gap-1">
                                  <Link20Regular className="w-3 h-3" />
                                  {t.duplicates.hardlinkShort}
                                </span>
                              </Badge>
                            ) : (
                              <Badge tone="success">
                                {formatBytes(group.potential_savings_bytes)} {t.duplicates.reclaimable}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Copies */}
                        {isExpanded && (
                          <div className="divide-y divide-[var(--border-divider)] border-t border-[var(--border-divider)]">
                            {group.files.map((file) => {
                              const isProtected = isProtectedSystemFile(file.path);
                              return (
                                <div
                                  key={file.path}
                                  onClick={() => toggleSelectFile(group.group_id, file.path)}
                                  className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-[var(--fill-subtle)] transition-colors"
                                >
                                  <input
                                    type="checkbox"
                                    checked={file.selected}
                                    disabled={!file.selected && isProtected}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => toggleSelectFile(group.group_id, file.path)}
                                    className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="font-code text-xs text-[var(--text-primary)] truncate select-all" title={file.path}>
                                      {file.path}
                                    </div>
                                    <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-muted)]">
                                      <span>{t.common.date}: {new Date(file.modified_at * 1000).toLocaleString()}</span>
                                      {file.is_hardlink_or_clone && (
                                        <Badge tone="warning">
                                          <span title={t.duplicates.hardlinkNotice}>{t.duplicates.hardlinkShort}</span>
                                        </Badge>
                                      )}
                                      {isProtected && <Badge tone="warning">{t.duplicates.protectedFile}</Badge>}
                                    </div>
                                  </div>
                                  <WinUIButton
                                    variant="subtle"
                                    size="sm"
                                    title={t.common.openInExplorer}
                                    aria-label={t.common.openInExplorer}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRevealInExplorer(file.path);
                                    }}
                                    icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                                  />
                                  <div className="w-16 flex justify-end shrink-0">
                                    {file.selected ? (
                                      <Badge tone="danger">{t.duplicates.deleteBadge}</Badge>
                                    ) : (
                                      <Badge tone="neutral">{t.duplicates.keepBadge}</Badge>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={<DocumentCopy20Regular />}
                  title={t.duplicates.noDuplicatesFound}
                  description={t.duplicates.noDuplicatesDesc}
                />
              )}
            </>
          ) : scanResult.folder_groups && scanResult.folder_groups.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Folder20Regular className="w-4 h-4 text-[var(--text-muted)]" />
                <span>
                  {scanResult.folder_groups.length} {t.duplicateFolders.foldersFound}
                </span>
              </div>
              {scanResult.folder_groups.map((fGroup) => (
                <Card key={fGroup.group_id} padded={false} className="overflow-hidden">
                  <div className="px-4 py-3 flex items-center gap-3">
                    <Folder20Regular className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
                    <div className="text-sm font-semibold text-[var(--text-primary)] truncate flex-1 min-w-0">
                      {fGroup.directories.length} {t.duplicateFolders.tabFolders} · {fGroup.total_files} {t.duplicateFolders.identicalFiles}
                    </div>
                    <Badge tone="success">
                      {formatBytes(fGroup.potential_savings_bytes)} {t.duplicates.reclaimable}
                    </Badge>
                  </div>
                  <div className="divide-y divide-[var(--border-divider)] border-t border-[var(--border-divider)]">
                    {fGroup.directories.map((dir, dIdx) => (
                      <div
                        key={dir.path}
                        className="px-4 py-3 flex items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={dir.selected}
                          onChange={() => toggleSelectFolder(fGroup.group_id, dir.path)}
                          className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-code text-xs text-[var(--text-primary)] truncate" title={dir.path}>
                            {dir.path}
                          </div>
                          <div className="text-xs text-[var(--text-muted)] mt-0.5">
                            {dir.file_count} {t.common.files} · {formatBytes(dir.total_size_bytes)}
                          </div>
                        </div>
                        <Badge tone="neutral">{dIdx === 0 ? t.duplicates.original : t.duplicates.duplicate}</Badge>
                        <WinUIButton
                          variant="subtle"
                          size="sm"
                          title={t.duplicateFolders.revealInExplorer}
                          aria-label={t.duplicateFolders.revealInExplorer}
                          onClick={() => handleRevealInExplorer(dir.path)}
                          icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                        />
                        <WinUIButton
                          variant="standard"
                          size="sm"
                          disabled={busy}
                          onClick={() => handleTrashFolders([dir.path])}
                          className="text-[var(--danger)]"
                        >
                          {t.duplicateFolders.recycleFolder}
                        </WinUIButton>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Folder20Regular />}
              title={t.duplicateFolders.noFoldersFound}
              description={t.duplicateFolders.noFoldersDesc}
            />
          )}
        </>
      )}

      {/* Selection actions */}
      {scanResult && !scanning && activeTab === "files" && totalSelectedCount > 0 && (
        <ActionBar
          summary={
            <>
              <span className="font-semibold text-[var(--text-primary)]">
                {totalSelectedCount} {t.duplicates.selected}
              </span>{" "}
              · <span className="font-ibm-mono">{formatBytes(totalSelectedBytes)}</span>
            </>
          }
        >
          <WinUIButton variant="subtle" onClick={() => applyHeuristic("none")} disabled={busy}>
            {t.common.clear}
          </WinUIButton>
          <WinUIButton
            variant="danger"
            onClick={requestTrashSelected}
            disabled={busy}
            icon={<Delete20Regular className="w-4 h-4" />}
          >
            {trashing ? t.duplicates.trashingProgress : t.duplicates.moveToRecycleBin}
          </WinUIButton>
        </ActionBar>
      )}
      {scanResult && !scanning && activeTab === "folders" && folderSelectedCount > 0 && (
        <ActionBar
          summary={
            <span className="font-semibold text-[var(--text-primary)]">
              {folderSelectedCount} {t.duplicates.selected}
            </span>
          }
        >
          <WinUIButton
            variant="danger"
            onClick={() => handleTrashFolders()}
            disabled={busy}
            icon={<Delete20Regular className="w-4 h-4" />}
          >
            {trashing ? t.duplicateFolders.recyclingFolders : t.duplicateFolders.recycleSelectedFolders}
          </WinUIButton>
        </ActionBar>
      )}

      {/* Safety confirmation */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fadeIn">
          <Card className="max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t.duplicates.trashConfirm || "Confirm Duplicate File Disposal"}
                </h3>
                <p className="text-sm text-[var(--text-secondary)] mt-1">
                  Move <span className="font-semibold text-[var(--text-primary)] font-ibm-mono">{totalSelectedCount}</span> duplicate file(s) to Recycle Bin, freeing approx{" "}
                  <span className="font-semibold text-[var(--success)] font-ibm-mono">{formatBytes(totalSelectedBytes)}</span>.
                </p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--fill-subtle)] p-3 text-sm space-y-2">
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Selected duplicate copies:</span>
                <span className="font-ibm-mono text-[var(--text-primary)] font-semibold">{totalSelectedCount}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Space to reclaim:</span>
                <span className="font-ibm-mono text-[var(--success)] font-semibold">{formatBytes(totalSelectedBytes)}</span>
              </div>
              <div className="flex justify-between text-[var(--text-secondary)]">
                <span>Disposal method:</span>
                <span className="text-[var(--success)] font-medium">Windows Recycle Bin (Restorable)</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--border-divider)]">
              <WinUIButton variant="standard" onClick={() => setShowConfirmModal(false)} disabled={trashing}>
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
                {t.duplicates.moveToRecycleBin}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default DuplicatesPage;
