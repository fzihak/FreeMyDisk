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
  DocumentFolder24Filled,
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
  CheckmarkCircle20Filled,
  Checkmark16Filled,
  FolderOpen20Regular,
  Folder20Regular,
} from "@fluentui/react-icons";

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
  failed_trash_paths: string[];
}

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
        setNotification("Scan was cancelled by user.");
      } else {
        console.error("Large files scan failed:", e);
        setNotification(`Scan failed: ${errStr}`);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    try {
      await invoke("cancel_active_scan", { kind: "large_files" });
      setScanning(false);
      setNotification("Scan cancelled.");
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
        setNotification(`Moved "${fileName}" to Recycle Bin (${formatBytes(res.bytes_freed)} freed).`);
        toast.success("File Recycled", `Moved "${fileName}" to Recycle Bin (${formatBytes(res.bytes_freed)} freed).`);
        setTimeout(() => setNotification(null), 5000);
      } else {
        toast.error("Failed to Recycle File", res.error || "Unknown error");
      }
    } catch (e) {
      toast.error("Error Trashing File", String(e));
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
          "Files Recycled",
          `Safely moved ${summary.successful_items} large file(s) to Recycle Bin (${formatBytes(summary.total_freed_bytes)} reclaimed).`
        );
      }
      if (summary.failed_items > 0) {
        toast.error(
          "Some Files Failed",
          `${summary.failed_items} file(s) could not be recycled (may be in use or locked).`
        );
      }
      setShowConfirmModal(false);
    } catch (e: any) {
      console.error("Batch trash failed:", e);
      toast.error("Batch Recycle Failed", String(e));
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
        return <MoviesAndTv20Regular className="w-4 h-4 text-purple-400" />;
      case "Archives":
        return <Archive20Regular className="w-4 h-4 text-amber-400" />;
      case "Documents":
        return <DocumentText20Regular className="w-4 h-4 text-blue-400" />;
      case "Binaries":
        return <AppFolder20Regular className="w-4 h-4 text-rose-400" />;
      default:
        return <QuestionCircle20Regular className="w-4 h-4 text-[var(--text-muted)]" />;
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

  // Batch selection calculations
  const selectedFilesList = useMemo(() => {
    if (!scanResult || selectedPaths.size === 0) return [];
    return scanResult.files.filter((f) => selectedPaths.has(f.path));
  }, [scanResult, selectedPaths]);

  const totalSelectedBytes = useMemo(() => {
    return selectedFilesList.reduce((acc, f) => acc + f.size_bytes, 0);
  }, [selectedFilesList]);

  const isAllFilteredSelected = useMemo(() => {
    if (filteredFiles.length === 0) return false;
    return filteredFiles.every((f) => selectedPaths.has(f.path));
  }, [filteredFiles, selectedPaths]);

  const isSomeFilteredSelected = useMemo(() => {
    if (filteredFiles.length === 0 || isAllFilteredSelected) return false;
    return filteredFiles.some((f) => selectedPaths.has(f.path));
  }, [filteredFiles, selectedPaths, isAllFilteredSelected]);

  // Batch selection handlers
  const handleToggleRow = (index: number, path: string, event?: React.MouseEvent) => {
    const next = new Set(selectedPaths);
    if (event?.shiftKey && lastSelectedIndex !== null && lastSelectedIndex !== index) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const targetState = !selectedPaths.has(path);
      for (let i = start; i <= end; i++) {
        const item = filteredFiles[i];
        if (item) {
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
      filteredFiles.forEach((f) => next.delete(f.path));
    } else {
      filteredFiles.forEach((f) => next.add(f.path));
    }
    setSelectedPaths(next);
  };

  const handleSelectAllFiltered = () => {
    const next = new Set(selectedPaths);
    filteredFiles.forEach((f) => next.add(f.path));
    setSelectedPaths(next);
  };

  const handleDeselectAll = () => {
    setSelectedPaths(new Set());
    setLastSelectedIndex(null);
  };

  const handleInvertFiltered = () => {
    const next = new Set(selectedPaths);
    filteredFiles.forEach((f) => {
      if (next.has(f.path)) next.delete(f.path);
      else next.add(f.path);
    });
    setSelectedPaths(next);
  };

  const handleSelectGreaterThan = (bytes: number) => {
    const next = new Set(selectedPaths);
    filteredFiles.forEach((f) => {
      if (f.size_bytes >= bytes) {
        next.add(f.path);
      }
    });
    setSelectedPaths(next);
  };

  const handleSelectOlderThanDays = (days: number) => {
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const next = new Set(selectedPaths);
    filteredFiles.forEach((f) => {
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
      ? `All Drives (${volumes.length > 0 ? volumes.map((v) => v.mount_point).join(", ") : "All"})`
      : selectedDrive;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-32">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <DocumentFolder24Filled className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.largeFiles.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] text-[10px] font-ibm-mono uppercase tracking-wider bg-[#0078d4]/10 text-[#0078d4] border border-[#0078d4]/20">
                {t.largeFiles.scannerBadge}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.largeFiles.subtitle}
            </p>
          </div>
        </div>

        {/* Quick Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2 bg-black/20 px-2.5 py-1 rounded-[4px] border border-[var(--border-card)]">
            <span className="text-[11px] text-[var(--text-secondary)] font-medium">{t.largeFiles.minSize}</span>
            <select
              value={minSizeMb}
              disabled={scanning || batchTrashing || Boolean(trashingPath)}
              onChange={(e) => {
                const val = Number(e.target.value);
                setMinSizeMb(val);
                handleScan(selectedDrive, val);
              }}
              className="bg-transparent text-[var(--text-primary)] text-xs font-ibm-mono font-semibold focus:outline-none cursor-pointer disabled:opacity-50"
            >
              <option value={50} className="bg-[#202020] text-[var(--text-primary)]">≥ 50 MB</option>
              <option value={100} className="bg-[#202020] text-[var(--text-primary)]">≥ 100 MB</option>
              <option value={250} className="bg-[#202020] text-[var(--text-primary)]">≥ 250 MB</option>
              <option value={500} className="bg-[#202020] text-[var(--text-primary)]">≥ 500 MB</option>
              <option value={1024} className="bg-[#202020] text-[var(--text-primary)]">≥ 1 GB</option>
              <option value={2048} className="bg-[#202020] text-[var(--text-primary)]">≥ 2 GB</option>
            </select>
          </div>

          <WinUIButton
            variant="primary"
            onClick={() => handleScan()}
            disabled={scanning || batchTrashing || Boolean(trashingPath)}
            className="flex items-center gap-1.5"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
            <span>{scanning ? t.common.scanning : t.common.rescan}</span>
          </WinUIButton>
        </div>
      </div>

      {/* Drive Selection Pills */}
      {volumes.length > 0 && (
        <WinUICard className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
            <HardDrive20Regular className="w-4 h-4 text-[#0078d4]" />
            <span>{t.largeFiles.selectDrive}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setSelectedDrive("ALL");
                handleScan("ALL", minSizeMb);
              }}
              disabled={scanning || batchTrashing || Boolean(trashingPath)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-[4px] text-xs transition-all ${
                scanning || batchTrashing || Boolean(trashingPath) ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
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
                    handleScan(vol.mount_point, minSizeMb);
                  }}
                  disabled={scanning || batchTrashing || Boolean(trashingPath)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-[4px] text-xs transition-all ${
                    scanning || batchTrashing || Boolean(trashingPath) ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
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
                const custom = prompt(t.largeFiles.customPathPrompt, selectedDrive === "ALL" ? "C:\\" : selectedDrive);
                if (custom && custom.trim()) {
                  setSelectedDrive(custom.trim());
                  handleScan(custom.trim(), minSizeMb);
                }
              }}
              disabled={scanning || batchTrashing || Boolean(trashingPath)}
              className={`px-3 py-1.5 rounded-[4px] text-xs font-medium bg-black/20 hover:bg-white/[0.05] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)] transition-all flex items-center gap-1.5 ${
                scanning || batchTrashing || Boolean(trashingPath) ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
              }`}
            >
              <Folder20Regular className="w-3.5 h-3.5" />
              <span>{t.common.showInFolder}...</span>
            </button>
          </div>
        </WinUICard>
      )}

      {/* Notification */}
      {notification && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs text-emerald-400 font-medium">{notification}</span>
          </div>
          <button
            onClick={() => setNotification(null)}
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
            <span className="font-medium text-[11px]">{t.common.files}</span>
            <DocumentFolder24Filled className="w-3.5 h-3.5 text-[#0078d4]" />
          </div>
          <div className="text-xl font-bold text-[var(--text-primary)] font-ibm-mono tabular-nums">
            {scanResult ? scanResult.total_files.toLocaleString() : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono mt-1">
            ≥ {minSizeMb} MB
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.largeFiles.totalSpace}</span>
            <HardDrive20Regular className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-xl font-bold text-indigo-400 font-ibm-mono tabular-nums">
            {scanResult ? formatBytes(scanResult.total_bytes) : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono truncate mt-1">
            {scanTargetLabel}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.largeFiles.categoryMedia}</span>
            <MoviesAndTv20Regular className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-xl font-bold text-purple-400 font-ibm-mono tabular-nums">
            {categoryStats["Media"] ? formatBytes(categoryStats["Media"].bytes) : "0 B"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono tabular-nums mt-1">
            {categoryStats["Media"]?.count || 0} {t.common.files}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1">
            <span className="font-medium text-[11px]">{t.largeFiles.categoryArchives}</span>
            <Archive20Regular className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-xl font-bold text-amber-400 font-ibm-mono tabular-nums">
            {categoryStats["Archives"] ? formatBytes(categoryStats["Archives"].bytes) : "0 B"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)] font-ibm-mono tabular-nums mt-1">
            {categoryStats["Archives"]?.count || 0} {t.common.files}
          </div>
        </WinUICard>
      </div>

      {/* Category Filter & Search Bar */}
      <WinUICard className="p-3 flex flex-col lg:flex-row items-center justify-between gap-3">
        {/* Category Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto w-full lg:w-auto pb-1 lg:pb-0">
          {categories.map((cat) => {
            const count = categoryStats[cat]?.count || 0;
            const bytes = categoryStats[cat]?.bytes || 0;
            const isActive = activeCategory === cat;

            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1 rounded-[4px] text-xs font-medium transition-all flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  isActive
                    ? "bg-[#0078d4] text-white"
                    : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
                }`}
              >
                <span>{getCategoryLabel(cat)}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-ibm-mono tabular-nums ${isActive ? "bg-white/20 text-white" : "bg-black/30 text-[var(--text-muted)]"}`}>
                  {count} • {formatBytes(bytes)}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search & Sort */}
        <div className="flex items-center gap-2.5 w-full lg:w-auto justify-end">
          <div className="relative flex-1 lg:w-56">
            <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder={t.largeFiles.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#0078d4]"
            />
          </div>

          <div className="flex items-center gap-1.5 bg-black/20 px-2 py-1 rounded-[4px] border border-[var(--border-card)]">
            <ArrowSort20Regular className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-transparent text-[var(--text-primary)] text-xs font-medium focus:outline-none cursor-pointer"
            >
              <option value="size-desc" className="bg-[#202020] text-[var(--text-primary)]">{t.largeFiles.sortSizeDesc}</option>
              <option value="size-asc" className="bg-[#202020] text-[var(--text-primary)]">{t.largeFiles.sortSizeAsc}</option>
              <option value="date-desc" className="bg-[#202020] text-[var(--text-primary)]">{t.largeFiles.sortDateDesc}</option>
              <option value="name" className="bg-[#202020] text-[var(--text-primary)]">{t.largeFiles.sortName}</option>
            </select>
          </div>
        </div>
      </WinUICard>

      {/* Files Table / Progress / Empty States */}
      {scanning ? (
        <LiveScanProgressWidget
          scanType="large_files"
          title={t.largeFiles.scanning}
          subtitle={`Target: ${scanTargetLabel} • ${t.largeFiles.minSize} ≥ ${minSizeMb} MB`}
          onCancel={handleCancelScan}
        />
      ) : batchTrashing ? (
        <LiveScanProgressWidget
          scanType="disposal"
          title="Recycling large files..."
          subtitle="Safely moving selected files to Windows Recycle Bin"
          showCancel={false}
        />
      ) : !scanResult ? (
        <WinUICard className="p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center mx-auto text-[#0078d4]">
            <HardDrive20Regular className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.largeFiles.readyTitle} ({scanTargetLabel})</h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
              {t.largeFiles.readyDesc}
            </p>
          </div>
          <div className="pt-2">
            <WinUIButton
              variant="primary"
              onClick={() => handleScan()}
              className="inline-flex items-center gap-1.5"
            >
              <Search20Regular className="w-3.5 h-3.5" />
              <span>{t.largeFiles.startScan}</span>
            </WinUIButton>
          </div>
        </WinUICard>
      ) : filteredFiles.length > 0 ? (
        <WinUICard className="overflow-hidden">
          {/* Quick Batch Selection Preset Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-black/15 border-b border-[var(--border-divider)] text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--text-muted)] font-medium mr-1">Select:</span>
              <button
                onClick={handleSelectAllFiltered}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                {t.common.selectAll}
              </button>
              <button
                onClick={handleDeselectAll}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                {t.common.deselectAll}
              </button>
              <button
                onClick={handleInvertFiltered}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                Invert
              </button>
              <span className="text-[var(--border-subtle)] mx-0.5">|</span>
              <button
                onClick={() => handleSelectGreaterThan(1024 * 1024 * 1024)}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                &gt; 1 GB
              </button>
              <button
                onClick={() => handleSelectGreaterThan(500 * 1024 * 1024)}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                &gt; 500 MB
              </button>
              <button
                onClick={() => handleSelectOlderThanDays(30)}
                className="px-2 py-0.5 rounded-[3px] text-[11px] font-medium bg-black/20 hover:bg-white/[0.06] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors"
              >
                &gt; 30 Days Old
              </button>
            </div>
            <div className="text-[11px] font-ibm-mono text-[var(--text-muted)]">
              {selectedPaths.size > 0 ? (
                <span className="text-[#0078d4] font-semibold">
                  {selectedPaths.size} selected ({formatBytes(totalSelectedBytes)})
                </span>
              ) : (
                <span>Tip: Shift+Click to select ranges</span>
              )}
            </div>
          </div>

          {/* Table Header with Master Checkbox */}
          <div className="px-4 py-2.5 bg-black/25 border-b border-[var(--border-divider)] flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider font-ibm-mono">
            <div className="flex items-center gap-3">
              <button
                onClick={handleToggleMasterCheckbox}
                title={isAllFilteredSelected ? t.common.deselectAll : t.common.selectAll}
                className={`w-4 h-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                  isAllFilteredSelected || isSomeFilteredSelected
                    ? "bg-[#0078d4] border-[#0078d4] text-white"
                    : "border-[var(--border-subtle)] bg-black/20 hover:border-[var(--border-card)]"
                }`}
              >
                {isAllFilteredSelected && <Checkmark16Filled className="w-3 h-3 text-white" />}
                {isSomeFilteredSelected && <div className="w-2 h-0.5 bg-white rounded-xs" />}
              </button>
              <span>{t.common.name} & {t.common.path}</span>
            </div>
            <span>{t.common.size} & {t.common.actions}</span>
          </div>

          {/* File Rows */}
          <div className="divide-y divide-[var(--border-divider)]">
            {filteredFiles.map((file, idx) => {
              const percentage = Math.max(5, Math.round((file.size_bytes / maxFileSize) * 100));
              const isSelected = selectedPaths.has(file.path);

              return (
                <div
                  key={file.path}
                  onClick={(e) => handleToggleRow(idx, file.path, e)}
                  className={`px-4 py-3 flex items-center justify-between gap-4 transition-colors cursor-pointer select-none ${
                    isSelected
                      ? "bg-[#0078d4]/10 hover:bg-[#0078d4]/15 border-l-2 border-[#0078d4]"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {/* Row Checkbox */}
                    <div
                      className={`w-4 h-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "bg-[#0078d4] border-[#0078d4] text-white"
                          : "border-[var(--border-subtle)] bg-black/20"
                      }`}
                    >
                      {isSelected && <Checkmark16Filled className="w-3 h-3 text-white" />}
                    </div>

                    <div className="p-2 rounded-[4px] bg-black/20 border border-[var(--border-subtle)] shrink-0 text-[var(--text-secondary)]">
                      {getCategoryIcon(file.category)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)] text-xs font-ibm-mono truncate select-all">
                          {file.name}
                        </span>
                        <span className="text-[10px] font-ibm-mono uppercase px-1.5 py-0.2 rounded-[3px] bg-[#0078d4]/10 text-[#0078d4] border border-[#0078d4]/20">
                          {file.extension || file.category}
                        </span>
                      </div>

                      <div className="text-[11px] font-ibm-mono text-[var(--text-secondary)] truncate mt-0.5 select-all">
                        {file.path}
                      </div>

                      <div className="text-[10px] font-ibm-mono text-[var(--text-muted)] mt-0.5 tabular-nums">
                        {t.common.date}: {new Date(file.modified_at * 1000).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  {/* Actions: Size bar, Reveal in explorer, Trash */}
                  <div className="flex items-center gap-3 shrink-0 font-ibm-mono tabular-nums">
                    <div className="hidden sm:flex flex-col items-end w-28">
                      <div className="text-xs font-bold text-[var(--text-primary)]">
                        {formatBytes(file.size_bytes)}
                      </div>
                      <div className="w-full bg-black/30 h-1.5 rounded-full overflow-hidden mt-1 border border-[var(--border-subtle)]">
                        <div
                          className="bg-[#0078d4] h-full rounded-full"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>

                    <div className="sm:hidden text-xs font-bold text-[var(--text-primary)]">
                      {formatBytes(file.size_bytes)}
                    </div>

                    {/* Show in File Explorer Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRevealInExplorer(file.path);
                      }}
                      title={t.common.openInExplorer}
                      className="p-1.5 bg-black/20 hover:bg-[#0078d4] hover:text-white text-[var(--text-secondary)] rounded-[4px] transition-all cursor-pointer border border-[var(--border-card)]"
                    >
                      <FolderOpen20Regular className="w-3.5 h-3.5" />
                    </button>

                    {/* Quick Trash Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleQuickTrash(file.path);
                      }}
                      disabled={trashingPath === file.path || batchTrashing}
                      title={t.largeFiles.trashSelected}
                      className="p-1.5 bg-black/20 hover:bg-rose-500/20 hover:text-rose-400 text-[var(--text-muted)] rounded-[4px] transition-all cursor-pointer disabled:opacity-50 border border-[var(--border-card)]"
                    >
                      <Delete20Regular className={`w-3.5 h-3.5 ${trashingPath === file.path ? "animate-spin text-rose-400" : ""}`} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </WinUICard>
      ) : scanResult.files.length === 0 ? (
        <WinUICard className="p-12 text-center space-y-2">
          <DocumentFolder24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.largeFiles.noFilesFound}</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.largeFiles.noFilesDesc}
          </p>
        </WinUICard>
      ) : (
        <WinUICard className="p-12 text-center space-y-2">
          <DocumentFolder24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.common.noResults}</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.largeFiles.noFilesDesc}
          </p>
        </WinUICard>
      )}

      {/* Floating / Sticky Batch Action Bar */}
      {selectedPaths.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[94%] max-w-4xl p-3.5 bg-[#1c1c1c]/95 backdrop-blur-md border border-[#0078d4]/40 rounded-lg shadow-2xl flex flex-col sm:flex-row items-center justify-between gap-3 animate-fadeIn">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="w-8 h-8 rounded-[4px] bg-[#0078d4]/20 border border-[#0078d4]/30 flex items-center justify-center text-[#0078d4] shrink-0">
              <CheckmarkCircle20Filled className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-white flex items-center gap-2">
                <span>{selectedPaths.size} {t.common.files} selected</span>
                <span className="text-[#0078d4] font-ibm-mono font-bold">
                  ({formatBytes(totalSelectedBytes)})
                </span>
              </div>
              <div className="text-[11px] text-[var(--text-secondary)] font-ibm-mono">
                Ready to safely recycle to Windows Recycle Bin
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <WinUIButton
              variant="standard"
              onClick={handleDeselectAll}
              disabled={batchTrashing}
            >
              <span>{t.common.deselectAll}</span>
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
              className="flex items-center gap-1.5"
            >
              {batchTrashing ? (
                <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
              ) : (
                <Delete20Regular className="w-4 h-4" />
              )}
              <span>
                {batchTrashing
                  ? "Recycling..."
                  : `Recycle Selected (${formatBytes(totalSelectedBytes)})`}
              </span>
            </WinUIButton>
          </div>
        </div>
      )}

      {/* Safety Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
          <WinUICard className="max-w-lg w-full p-5 space-y-4 shadow-2xl border border-rose-500/30">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-[4px] bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Move {selectedPaths.size} large files to Recycle Bin?
                </h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  A total of <span className="text-rose-400 font-bold font-ibm-mono">{formatBytes(totalSelectedBytes)}</span> will be freed. Files are safely moved to the Windows Recycle Bin and can be restored if needed.
                </p>
              </div>
            </div>

            {/* Selected Items Preview */}
            <div className="bg-black/30 border border-[var(--border-subtle)] rounded-[4px] p-2 max-h-48 overflow-y-auto space-y-1">
              {selectedFilesList.slice(0, 10).map((f) => (
                <div key={f.path} className="flex items-center justify-between text-xs py-1 px-2 hover:bg-white/[0.03] rounded-[3px]">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {getCategoryIcon(f.category)}
                    <span className="truncate font-ibm-mono text-[var(--text-primary)] text-[11px]">{f.name}</span>
                  </div>
                  <span className="font-ibm-mono font-semibold text-[var(--text-secondary)] text-[11px] shrink-0 ml-2">
                    {formatBytes(f.size_bytes)}
                  </span>
                </div>
              ))}
              {selectedFilesList.length > 10 && (
                <div className="text-[11px] text-[var(--text-muted)] text-center py-1 font-ibm-mono">
                  + {selectedFilesList.length - 10} more files
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <WinUIButton
                variant="standard"
                onClick={() => setShowConfirmModal(false)}
                disabled={batchTrashing}
              >
                <span>{t.common.cancel}</span>
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleBatchTrash}
                disabled={batchTrashing}
                className="flex items-center gap-1.5"
              >
                {batchTrashing && <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin" />}
                <span>{batchTrashing ? "Recycling..." : t.largeFiles.trashSelected}</span>
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};

export default LargeFilesPage;
