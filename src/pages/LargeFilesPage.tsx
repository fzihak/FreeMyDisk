import React, { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState, ActionBar } from "@/components/ui";
import {
  DocumentFolder20Regular,
  Delete20Regular,
  ArrowClockwise20Regular,
  MoviesAndTv20Regular,
  Archive20Regular,
  DocumentText20Regular,
  AppFolder20Regular,
  QuestionCircle20Regular,
  Search20Regular,
  ArrowSort20Regular,
  HardDrive20Regular,
  Info20Regular,
  FolderOpen20Regular,
  Folder20Regular,
  DismissCircle20Regular,
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

interface LargeFileEntry {
  path: string;
  name: string;
  size_bytes: number;
  modified_at: number;
  category: "Media" | "Archives" | "Documents" | "Binaries" | "Other";
  extension: string;
}

interface LargeFilesScanResult {
  total_files: number;
  total_bytes: number;
  files: LargeFileEntry[];
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
  failed_trash_paths: string[];
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

/** Fills `{name}` placeholders in a translated string. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** Short size for drive chips: "21 GB", "1.8 TB". */
const compactBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return "0 GB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
};

const MIN_SIZE_OPTIONS: Array<{ mb: number; label: string }> = [
  { mb: 50, label: "50 MB" },
  { mb: 100, label: "100 MB" },
  { mb: 250, label: "250 MB" },
  { mb: 500, label: "500 MB" },
  { mb: 1024, label: "1 GB" },
  { mb: 2048, label: "2 GB" },
];

const controlClass =
  "h-8 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50";

export const LargeFilesPage: React.FC = () => {
  const { t } = useI18nStore();
  const { confirmBeforeDelete } = useSettingsStore();
  const [volumes, setVolumes] = useState<StorageVolumeInfo[]>([]);
  const [minSizeMb, setMinSizeMb] = useState<number>(100);
  const [selectedDrive, setSelectedDrive] = useState<string>("ALL");
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortBy, setSortBy] = useState<"size-desc" | "size-asc" | "date-desc" | "name">("size-desc");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<LargeFilesScanResult | null>(null);
  const [trashingPath, setTrashingPath] = useState<string | null>(null);
  const [notification, setNotification] = useState<string | null>(null);

  // Batch Selection State
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [batchTrashing, setBatchTrashing] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const handleScan = async (targetDrive = selectedDrive, minMb = minSizeMb) => {
    setScanning(true);
    setNotification(null);
    setSelectedPaths(new Set());
    setLastSelectedIndex(null);
    try {
      const rootsToScan =
        targetDrive === "ALL"
          ? (volumes.length > 0 ? volumes.map((v) => v.mount_point) : ["C:\\"])
          : [targetDrive];

      const res = await invoke<LargeFilesScanResult>("scan_large_files", {
        roots: rootsToScan,
        minSizeBytes: minMb * 1024 * 1024,
      });
      setScanResult(res);
    } catch (e: any) {
      const errStr = String(e || "");
      if (errStr.toLowerCase().includes("cancel") || errStr.toLowerCase().includes("aborted")) {
        setNotification(t.largeFiles.scanCancelledByUser);
      } else {
        console.error("Large files scan failed:", e);
        setNotification(fill(t.largeFiles.scanFailed, { error: errStr }));
      }
    } finally {
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    try {
      await invoke("cancel_active_scan", { kind: "large_files" });
      setScanning(false);
      setNotification(t.largeFiles.scanCancelled);
      setTimeout(() => setNotification(null), 4000);
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

  const handleQuickTrash = async (path: string) => {
    setTrashingPath(path);
    try {
      const res = await invoke<DisposalItemResult>("trash_large_file", { path });
      if (res.success) {
        if (scanResult) {
          const nextFiles = scanResult.files.filter((f) => f.path !== path);
          setScanResult({
            ...scanResult,
            total_files: nextFiles.length,
            total_bytes: nextFiles.reduce((acc, f) => acc + f.size_bytes, 0),
            files: nextFiles,
          });
        }
        if (selectedPaths.has(path)) {
          const nextSelected = new Set(selectedPaths);
          nextSelected.delete(path);
          setSelectedPaths(nextSelected);
        }
        const fileName = path.split(/[\\/]/).pop() || path;
        const message = fill(t.largeFiles.fileRecycledDesc, { name: fileName, size: formatBytes(res.bytes_freed) });
        setNotification(message);
        toast.success(t.largeFiles.fileRecycledTitle, message);
        setTimeout(() => setNotification(null), 5000);
      } else {
        toast.error(t.largeFiles.recycleFailedTitle, res.error || t.largeFiles.unknownError);
      }
    } catch (e) {
      toast.error(t.largeFiles.trashErrorTitle, String(e));
    } finally {
      setTrashingPath(null);
    }
  };

  const handleBatchTrash = async () => {
    if (!scanResult || selectedPaths.size === 0) return;
    setBatchTrashing(true);
    try {
      const pathsToTrash = Array.from(selectedPaths);
      const summary = await invoke<DisposalSummary>("trash_large_files", {
        paths: pathsToTrash,
      });

      const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const failedSet = new Set((summary.failed_trash_paths || []).map(normalize));
      const successfulSet = new Set(pathsToTrash.filter((p) => !failedSet.has(normalize(p))).map(normalize));

      const remainingFiles = scanResult.files.filter((f) => !successfulSet.has(normalize(f.path)));

      setScanResult({
        ...scanResult,
        total_files: remainingFiles.length,
        total_bytes: remainingFiles.reduce((acc, f) => acc + f.size_bytes, 0),
        files: remainingFiles,
      });

      const remainingSelected = new Set(pathsToTrash.filter((p) => failedSet.has(normalize(p))));
      setSelectedPaths(remainingSelected);

      if (summary.successful_items > 0) {
        toast.success(
          t.largeFiles.filesRecycledTitle,
          `${summary.successful_items} ${t.common.files} · ${describeDisposal(summary, t, formatBytes)}`
        );
      }
      if (summary.failed_items > 0) {
        toast.error(t.largeFiles.someFailedTitle, fill(t.largeFiles.someFailedDesc, { count: summary.failed_items }));
      }
      setShowConfirmModal(false);
    } catch (e: any) {
      console.error("Batch trash failed:", e);
      toast.error(t.largeFiles.batchFailedTitle, String(e));
    } finally {
      setBatchTrashing(false);
    }
  };

  const handleRevealInExplorer = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (e) {
      console.error("Failed to reveal item in explorer:", e);
    }
  };

  const categories = ["All", "Media", "Archives", "Binaries", "Documents", "Other"];

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case "Media":
        return <MoviesAndTv20Regular className="w-4 h-4" />;
      case "Archives":
        return <Archive20Regular className="w-4 h-4" />;
      case "Documents":
        return <DocumentText20Regular className="w-4 h-4" />;
      case "Binaries":
        return <AppFolder20Regular className="w-4 h-4" />;
      default:
        return <QuestionCircle20Regular className="w-4 h-4" />;
    }
  };

  // Category counts & volume
  const categoryStats = useMemo(() => {
    if (!scanResult) return {};
    const map: Record<string, { count: number; bytes: number }> = {};
    for (const cat of categories) {
      map[cat] = { count: 0, bytes: 0 };
    }
    for (const f of scanResult.files) {
      if (map[f.category]) {
        map[f.category].count += 1;
        map[f.category].bytes += f.size_bytes;
      }
      map["All"].count += 1;
      map["All"].bytes += f.size_bytes;
    }
    return map;
  }, [scanResult]);

  // Filtered & Sorted files
  const filteredFiles = useMemo(() => {
    if (!scanResult) return [];
    let list = scanResult.files.filter((f) => {
      const matchCat = activeCategory === "All" || f.category === activeCategory;
      if (!matchCat) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q) || f.extension.toLowerCase().includes(q);
    });

    list.sort((a, b) => {
      if (sortBy === "size-desc") return b.size_bytes - a.size_bytes;
      if (sortBy === "size-asc") return a.size_bytes - b.size_bytes;
      if (sortBy === "date-desc") return b.modified_at - a.modified_at;
      if (sortBy === "name") return a.name.localeCompare(b.name);
      return 0;
    });

    return list;
  }, [scanResult, activeCategory, searchQuery, sortBy]);

  const maxFileSize = useMemo(() => {
    if (!scanResult || scanResult.files.length === 0) return 1;
    return Math.max(...scanResult.files.map((f) => f.size_bytes));
  }, [scanResult]);

  // Rows that may be selected for removal (protected system files are excluded)
  const selectableFiltered = useMemo(
    () => filteredFiles.filter((f) => !isProtectedSystemFile(f.path)),
    [filteredFiles]
  );

  // Batch selection calculations
  const selectedFilesList = useMemo(() => {
    if (!scanResult || selectedPaths.size === 0) return [];
    return scanResult.files.filter((f) => selectedPaths.has(f.path));
  }, [scanResult, selectedPaths]);

  const totalSelectedBytes = useMemo(() => {
    return selectedFilesList.reduce((acc, f) => acc + f.size_bytes, 0);
  }, [selectedFilesList]);

  const isAllFilteredSelected = useMemo(() => {
    if (selectableFiltered.length === 0) return false;
    return selectableFiltered.every((f) => selectedPaths.has(f.path));
  }, [selectableFiltered, selectedPaths]);

  const isSomeFilteredSelected = useMemo(() => {
    if (selectableFiltered.length === 0 || isAllFilteredSelected) return false;
    return selectableFiltered.some((f) => selectedPaths.has(f.path));
  }, [selectableFiltered, selectedPaths, isAllFilteredSelected]);

  // Batch selection handlers
  const handleToggleRow = (index: number, path: string, event?: React.MouseEvent) => {
    if (isProtectedSystemFile(path)) return;
    const next = new Set(selectedPaths);
    if (event?.shiftKey && lastSelectedIndex !== null && lastSelectedIndex !== index) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const targetState = !selectedPaths.has(path);
      for (let i = start; i <= end; i++) {
        const item = filteredFiles[i];
        if (item && !isProtectedSystemFile(item.path)) {
          if (targetState) next.add(item.path);
          else next.delete(item.path);
        }
      }
    } else {
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
    }
    setSelectedPaths(next);
    setLastSelectedIndex(index);
  };

  const handleToggleMasterCheckbox = () => {
    const next = new Set(selectedPaths);
    if (isAllFilteredSelected) {
      selectableFiltered.forEach((f) => next.delete(f.path));
    } else {
      selectableFiltered.forEach((f) => next.add(f.path));
    }
    setSelectedPaths(next);
  };

  const handleSelectAllFiltered = () => {
    const next = new Set(selectedPaths);
    selectableFiltered.forEach((f) => next.add(f.path));
    setSelectedPaths(next);
  };

  const handleDeselectAll = () => {
    setSelectedPaths(new Set());
    setLastSelectedIndex(null);
  };

  const handleInvertFiltered = () => {
    const next = new Set(selectedPaths);
    selectableFiltered.forEach((f) => {
      if (next.has(f.path)) next.delete(f.path);
      else next.add(f.path);
    });
    setSelectedPaths(next);
  };

  const handleSelectGreaterThan = (bytes: number) => {
    const next = new Set(selectedPaths);
    selectableFiltered.forEach((f) => {
      if (f.size_bytes >= bytes) {
        next.add(f.path);
      }
    });
    setSelectedPaths(next);
  };

  const handleSelectOlderThanDays = (days: number) => {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const next = new Set(selectedPaths);
    selectableFiltered.forEach((f) => {
      if (f.modified_at < cutoff) {
        next.add(f.path);
      }
    });
    setSelectedPaths(next);
  };

  const getCategoryLabel = (cat: string) => {
    switch (cat) {
      case "All": return t.largeFiles.categoryAll;
      case "Media": return t.largeFiles.categoryMedia;
      case "Archives": return t.largeFiles.categoryArchives;
      case "Documents": return t.largeFiles.categoryDocs;
      case "Binaries": return t.largeFiles.categoryBinaries;
      default: return t.largeFiles.categoryOther;
    }
  };

  const scanTargetLabel =
    selectedDrive === "ALL"
      ? volumes.length > 0
        ? `${t.common.allDrives} (${volumes.map((v) => v.mount_point.replace(/[\\/]+$/, "")).join(" ")})`
        : t.common.allDrives
      : selectedDrive;

  // Live progress from the backend (large_files scan and disposal events).
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

  // Master checkbox shows a dash when only part of the list is selected.
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = isSomeFilteredSelected;
  }, [isSomeFilteredSelected]);

  const busy = scanning || batchTrashing || Boolean(trashingPath);
  const isCustomTarget = selectedDrive !== "ALL" && !volumes.some((v) => v.mount_point === selectedDrive);

  const chipClass = (active: boolean) =>
    `h-9 px-3 rounded-md border text-sm inline-flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
      active
        ? "border-[var(--accent)] bg-[var(--fill-subtle)] text-[var(--text-primary)]"
        : "border-[var(--border-card)] text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)] cursor-pointer"
    }`;

  const quickSelect: Array<{ label: string; onClick: () => void }> = [
    { label: t.common.selectAll, onClick: handleSelectAllFiltered },
    { label: t.common.deselectAll, onClick: handleDeselectAll },
    { label: t.largeFiles.invertSelection, onClick: handleInvertFiltered },
    { label: "> 1 GB", onClick: () => handleSelectGreaterThan(1024 * 1024 * 1024) },
    { label: "> 500 MB", onClick: () => handleSelectGreaterThan(500 * 1024 * 1024) },
    { label: t.largeFiles.olderThan30Days, onClick: () => handleSelectOlderThanDays(30) },
  ];

  return (
    <Page className="select-none">
      <PageHeader
        icon={<DocumentFolder20Regular />}
        title={t.largeFiles.title}
        description={t.largeFiles.pageDesc}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span className="whitespace-nowrap">{t.largeFiles.minSize}</span>
              <select
                value={minSizeMb}
                disabled={busy}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMinSizeMb(val);
                  handleScan(selectedDrive, val);
                }}
                className={`${controlClass} px-2 font-ibm-mono cursor-pointer`}
              >
                {MIN_SIZE_OPTIONS.map((o) => (
                  <option key={o.mb} value={o.mb} className="bg-[var(--bg-card)] text-[var(--text-primary)]">
                    {fill(t.largeFiles.minSizeOption, { size: o.label })}
                  </option>
                ))}
              </select>
            </label>
            <WinUIButton
              variant="primary"
              onClick={() => handleScan()}
              disabled={busy}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
            >
              {scanning ? t.common.scanning : scanResult ? t.common.rescan : t.common.scan}
            </WinUIButton>
          </>
        }
      />

      {/* Drive picker */}
      {volumes.length > 0 && (
        <Card className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <HardDrive20Regular className="w-4 h-4 text-[var(--text-secondary)]" />
            <span>{t.largeFiles.selectDrive}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setSelectedDrive("ALL");
                handleScan("ALL", minSizeMb);
              }}
              disabled={busy}
              className={chipClass(selectedDrive === "ALL")}
            >
              <HardDrive20Regular className="w-4 h-4" />
              <span className="font-medium">{t.common.allDrives}</span>
              <span className="text-xs text-[var(--text-muted)] font-ibm-mono">{volumes.length}</span>
            </button>

            {volumes.map((vol) => {
              const isSelected = selectedDrive === vol.mount_point;
              return (
                <button
                  key={vol.mount_point}
                  onClick={() => {
                    setSelectedDrive(vol.mount_point);
                    handleScan(vol.mount_point, minSizeMb);
                  }}
                  disabled={busy}
                  title={vol.volume_name || t.common.drive}
                  className={chipClass(isSelected)}
                >
                  <span className="font-medium font-ibm-mono text-[var(--text-primary)]">
                    {vol.mount_point.replace(/[\\/]+$/, "")}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                    {fill(t.largeFiles.driveFreeOf, {
                      free: compactBytes(vol.available_bytes),
                      total: compactBytes(vol.total_bytes),
                    })}
                  </span>
                </button>
              );
            })}

            <button
              onClick={() => {
                const custom = prompt(t.largeFiles.customPathPrompt, selectedDrive === "ALL" ? "C:\\" : selectedDrive);
                if (custom && custom.trim()) {
                  setSelectedDrive(custom.trim());
                  handleScan(custom.trim(), minSizeMb);
                }
              }}
              disabled={busy}
              title={isCustomTarget ? selectedDrive : undefined}
              className={chipClass(isCustomTarget)}
            >
              <Folder20Regular className="w-4 h-4" />
              <span className="max-w-[220px] truncate">
                {isCustomTarget ? selectedDrive : `${t.common.showInFolder}…`}
              </span>
            </button>
          </div>
        </Card>
      )}

      {/* Notice line (cancel, failure, last single recycle) */}
      {notification && (
        <Card className="py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Info20Regular className="w-4 h-4 shrink-0 text-[var(--accent-text)]" />
            <span className="text-sm text-[var(--text-primary)] truncate" title={notification}>
              {notification}
            </span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setNotification(null)}>
            {t.common.dismiss}
          </WinUIButton>
        </Card>
      )}

      {scanning ? (
        <ScanProgressCard
          scanType="large_files"
          title={t.largeFiles.scanning}
          subtitle={fill(t.largeFiles.scanTarget, { target: scanTargetLabel, size: minSizeMb })}
          onCancel={handleCancelScan}
        />
      ) : !scanResult ? (
        <EmptyState
          icon={<HardDrive20Regular />}
          title={`${t.largeFiles.readyTitle} (${scanTargetLabel})`}
          description={t.largeFiles.readyDesc}
          action={
            <WinUIButton
              variant="primary"
              size="lg"
              onClick={() => handleScan()}
              icon={<Search20Regular className="w-4 h-4" />}
            >
              {t.largeFiles.startScan}
            </WinUIButton>
          }
        />
      ) : (
        <>
          {/* Stat row */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.largeFiles.statFound}
              value={scanResult.total_files.toLocaleString()}
              hint={fill(t.largeFiles.atLeastSize, { size: minSizeMb })}
              icon={<DocumentFolder20Regular />}
            />
            <StatCard
              label={t.largeFiles.statTotal}
              value={formatBytes(scanResult.total_bytes)}
              hint={<span title={scanTargetLabel}>{scanTargetLabel}</span>}
              icon={<HardDrive20Regular />}
            />
            <StatCard
              label={t.largeFiles.statMedia}
              value={formatBytes(categoryStats["Media"]?.bytes || 0)}
              hint={fill(t.largeFiles.fileCount, { count: categoryStats["Media"]?.count || 0 })}
              icon={<MoviesAndTv20Regular />}
            />
            <StatCard
              label={t.largeFiles.statArchives}
              value={formatBytes(categoryStats["Archives"]?.bytes || 0)}
              hint={fill(t.largeFiles.fileCount, { count: categoryStats["Archives"]?.count || 0 })}
              icon={<Archive20Regular />}
            />
          </div>

          {/* Category tabs, search and sort */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
            <FilterTabs
              items={categories.map((cat) => ({
                id: cat,
                label: getCategoryLabel(cat),
                count: `${categoryStats[cat]?.count || 0} · ${formatBytes(categoryStats[cat]?.bytes || 0)}`,
              }))}
              value={activeCategory}
              onChange={setActiveCategory}
              className="min-w-0"
            />
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative flex-1 xl:w-56">
                <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
                <input
                  type="text"
                  placeholder={t.largeFiles.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`${controlClass} w-full pl-8 pr-3 placeholder-[var(--text-muted)] select-text`}
                />
              </div>
              <div className="relative">
                <ArrowSort20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  title={t.largeFiles.sortBy}
                  className={`${controlClass} pl-8 pr-2 cursor-pointer`}
                >
                  <option value="size-desc" className="bg-[var(--bg-card)]">{t.largeFiles.sortSizeDesc}</option>
                  <option value="size-asc" className="bg-[var(--bg-card)]">{t.largeFiles.sortSizeAsc}</option>
                  <option value="date-desc" className="bg-[var(--bg-card)]">{t.largeFiles.sortDateDesc}</option>
                  <option value="name" className="bg-[var(--bg-card)]">{t.largeFiles.sortName}</option>
                </select>
              </div>
            </div>
          </div>

          {batchTrashing ? (
            <ScanProgressCard
              scanType="disposal"
              title={t.largeFiles.recyclingTitle}
              subtitle={t.largeFiles.recyclingDesc}
            />
          ) : filteredFiles.length > 0 ? (
            <Card padded={false} className="overflow-hidden">
              {/* Quick-select row */}
              <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-divider)]">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-xs text-[var(--text-muted)] mr-1">{t.largeFiles.selectLabel}</span>
                  {quickSelect.map((q, i) => (
                    <React.Fragment key={q.label}>
                      {i === 3 && <span className="w-px h-4 mx-1 bg-[var(--border-divider)]" />}
                      <WinUIButton variant="subtle" size="sm" onClick={q.onClick}>
                        {q.label}
                      </WinUIButton>
                    </React.Fragment>
                  ))}
                </div>
                <span className="text-xs text-[var(--text-muted)]">{t.largeFiles.shiftHint}</span>
              </div>

              {/* Column header with the master checkbox */}
              <div className="px-4 py-2 flex items-center gap-3 border-b border-[var(--border-divider)] text-xs text-[var(--text-secondary)]">
                <input
                  ref={masterRef}
                  type="checkbox"
                  checked={isAllFilteredSelected}
                  onChange={handleToggleMasterCheckbox}
                  disabled={selectableFiltered.length === 0}
                  title={isAllFilteredSelected ? t.common.deselectAll : t.common.selectAll}
                  className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                />
                <span className="w-8 shrink-0" />
                <span className="flex-1 min-w-0">{t.common.name}</span>
                <span className="hidden md:block w-24 shrink-0">{t.common.date}</span>
                <span className="w-28 shrink-0 text-right">{t.common.size}</span>
                <span className="w-[68px] shrink-0 text-right">{t.common.actions}</span>
              </div>

              <div className="divide-y divide-[var(--border-divider)]">
                {filteredFiles.map((file, idx) => {
                  const percentage = Math.max(5, Math.round((file.size_bytes / maxFileSize) * 100));
                  const isSelected = selectedPaths.has(file.path);
                  const isProtected = isProtectedSystemFile(file.path);
                  const modified = new Date(file.modified_at * 1000);

                  return (
                    <div
                      key={file.path}
                      onClick={(e) => handleToggleRow(idx, file.path, e)}
                      title={isProtected ? t.common.protectedSystemFile : undefined}
                      className={`px-4 py-3 flex items-center gap-3 transition-colors ${
                        isProtected ? "cursor-default opacity-60" : "cursor-pointer"
                      } ${isSelected ? "bg-[var(--fill-subtle)]" : "hover:bg-[var(--fill-subtle)]"}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isProtected}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleRow(idx, file.path, e);
                        }}
                        onChange={() => {}}
                        className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer disabled:cursor-default"
                      />

                      <span className="w-8 h-8 shrink-0 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)]">
                        {getCategoryIcon(file.category)}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm text-[var(--text-primary)] truncate select-all" title={file.name}>
                            {file.name}
                          </span>
                          <Badge className="font-ibm-mono shrink-0">{file.extension || file.category}</Badge>
                        </div>
                        <div
                          className="font-code text-xs text-[var(--text-muted)] truncate mt-0.5 select-all"
                          title={file.path}
                        >
                          {file.path}
                        </div>
                        <div className="md:hidden text-xs text-[var(--text-muted)] mt-0.5">
                          {fill(t.largeFiles.modifiedOn, { date: modified.toLocaleDateString() })}
                        </div>
                      </div>

                      <span
                        className="hidden md:block w-24 shrink-0 text-xs text-[var(--text-secondary)] tabular-nums"
                        title={modified.toLocaleString()}
                      >
                        {modified.toLocaleDateString()}
                      </span>

                      <div className="w-28 shrink-0 flex flex-col items-end gap-1">
                        <span className="text-sm font-ibm-mono tabular-nums text-[var(--text-primary)]">
                          {formatBytes(file.size_bytes)}
                        </span>
                        <ProgressBar value={percentage} />
                      </div>

                      <div className="w-[68px] shrink-0 flex items-center justify-end gap-1">
                        <span title={t.common.openInExplorer}>
                          <WinUIButton
                            variant="subtle"
                            size="sm"
                            className="w-8 !px-0"
                            aria-label={t.common.openInExplorer}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRevealInExplorer(file.path);
                            }}
                            icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                          />
                        </span>
                        {/* Wrapper keeps the tooltip working while the button is disabled */}
                        <span
                          title={isProtected ? t.common.protectedSystemFile : t.largeFiles.trashSelected}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <WinUIButton
                            variant="subtle"
                            size="sm"
                            className="w-8 !px-0"
                            aria-label={t.largeFiles.trashSelected}
                            disabled={isProtected || trashingPath === file.path || batchTrashing}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isProtected) handleQuickTrash(file.path);
                            }}
                            icon={
                              trashingPath === file.path ? (
                                <ArrowClockwise20Regular className="w-4 h-4 animate-spin text-[var(--text-secondary)]" />
                              ) : (
                                <Delete20Regular className="w-4 h-4 text-[var(--text-secondary)]" />
                              )
                            }
                          />
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : scanResult.files.length === 0 ? (
            <EmptyState
              icon={<DocumentFolder20Regular />}
              title={t.largeFiles.noFilesFound}
              description={t.largeFiles.noFilesDesc}
            />
          ) : (
            <EmptyState
              icon={<Search20Regular />}
              title={t.common.noResults}
              description={t.largeFiles.noFilesDesc}
            />
          )}
        </>
      )}

      {/* Sticky selection bar */}
      {selectedPaths.size > 0 && (
        <ActionBar
          summary={
            <span>
              <span className="font-semibold text-[var(--text-primary)]">
                {fill(t.largeFiles.selectedSummary, {
                  count: selectedPaths.size,
                  size: formatBytes(totalSelectedBytes),
                })}
              </span>
            </span>
          }
        >
          <WinUIButton variant="standard" onClick={handleDeselectAll} disabled={batchTrashing}>
            {t.common.deselectAll}
          </WinUIButton>
          <WinUIButton
            variant="danger"
            onClick={() => {
              if (confirmBeforeDelete) {
                setShowConfirmModal(true);
              } else {
                handleBatchTrash();
              }
            }}
            disabled={batchTrashing}
            icon={
              batchTrashing ? (
                <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
              ) : (
                <Delete20Regular className="w-4 h-4" />
              )
            }
          >
            {batchTrashing ? t.largeFiles.recycling : t.largeFiles.trashSelected}
          </WinUIButton>
        </ActionBar>
      )}

      {/* Safety confirmation */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">
                  {fill(t.largeFiles.confirmTitle, { count: selectedPaths.size })}
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  {fill(t.largeFiles.confirmDesc, { size: formatBytes(totalSelectedBytes) })}
                </p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] max-h-48 overflow-y-auto divide-y divide-[var(--border-divider)]">
              {selectedFilesList.slice(0, 10).map((f) => (
                <div key={f.path} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                  <div className="flex items-center gap-2 min-w-0 flex-1 text-[var(--text-secondary)]">
                    {getCategoryIcon(f.category)}
                    <span className="truncate text-[var(--text-primary)]" title={f.path}>
                      {f.name}
                    </span>
                  </div>
                  <span className="font-ibm-mono text-[var(--text-secondary)] shrink-0">{formatBytes(f.size_bytes)}</span>
                </div>
              ))}
              {selectedFilesList.length > 10 && (
                <div className="text-xs text-[var(--text-muted)] text-center py-1.5">
                  {fill(t.largeFiles.moreFiles, { count: selectedFilesList.length - 10 })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <WinUIButton variant="standard" onClick={() => setShowConfirmModal(false)} disabled={batchTrashing}>
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleBatchTrash}
                disabled={batchTrashing}
                icon={batchTrashing ? <ArrowClockwise20Regular className="w-4 h-4 animate-spin" /> : undefined}
              >
                {batchTrashing ? t.largeFiles.recycling : t.largeFiles.trashSelected}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default LargeFilesPage;

/** Live progress of a backend scan or disposal: bar, current path, file count, optional Cancel. */
const ScanProgressCard: React.FC<{
  scanType: string;
  title: string;
  subtitle?: string;
  onCancel?: () => void;
}> = ({ scanType, title, subtitle, onCancel }) => {
  const { t } = useI18nStore();
  const progress = useScanProgress(scanType);
  const percent = Math.max(1, Math.min(100, progress.percent || 1));

  const fmt = (bytes: number): string => {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
          {subtitle && <div className="text-xs text-[var(--text-secondary)] mt-0.5 truncate" title={subtitle}>{subtitle}</div>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm font-semibold font-ibm-mono tabular-nums">{percent}%</span>
          {onCancel && (
            <WinUIButton
              variant="standard"
              size="sm"
              onClick={onCancel}
              icon={<DismissCircle20Regular className="w-4 h-4" />}
            >
              {t.common.cancelScan}
            </WinUIButton>
          )}
        </div>
      </div>
      <ProgressBar value={percent} />
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
        <span className="font-code text-xs truncate min-w-0" title={progress.currentPath}>
          {progress.currentPath || t.largeFiles.preparingScan}
        </span>
        <span className="shrink-0 tabular-nums">
          {fill(t.largeFiles.itemsChecked, { count: progress.itemsScanned.toLocaleString() })}
          {progress.bytesFound > 0 && ` · ${fill(t.largeFiles.bytesFound, { size: fmt(progress.bytesFound) })}`}
        </span>
      </div>
    </Card>
  );
};
