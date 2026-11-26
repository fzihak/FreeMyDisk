import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { TreemapCanvas, StorageTreeNode } from "@/components/storage/TreemapCanvas";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import {
  HardDrive24Filled,
  HardDrive20Regular,
  Folder20Regular,
  Folder20Filled,
  Document20Regular,
  ArrowDownload20Regular,
  ChevronRight16Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  ArrowClockwise20Regular,
  DataPie20Regular,
  DataPie20Filled,
  Layer20Regular,
  FolderOpen20Regular,
  DismissCircle20Regular,
  Search20Regular,
  ArrowSort20Regular,
} from "@fluentui/react-icons";

interface StorageVolumeInfo {
  mount_point: string;
  volume_name: string;
  total_bytes: number;
  available_bytes: number;
  file_system: string;
  is_removable: boolean;
}

interface HeavyFolderNode {
  path: string;
  name: string;
  size_bytes: number;
  file_count: number;
  folder_count: number;
  is_system_protected: boolean;
  children: HeavyFolderNode[];
}

interface HeavyFoldersScanResult {
  root: string;
  min_size_bytes: number;
  total_scanned_bytes: number;
  total_scanned_files: number;
  heavy_folders: HeavyFolderNode[];
}

const HeavyFolderItem: React.FC<{
  node: HeavyFolderNode;
  totalVolumeBytes: number;
  formatBytes: (b: number) => string;
  onOpenInExplorer: (p: string) => void;
  depth?: number;
}> = ({ node, totalVolumeBytes, formatBytes, onOpenInExplorer, depth = 0 }) => {
  const { t } = useI18nStore();
  const [expanded, setExpanded] = useState(depth === 0);
  const pct = totalVolumeBytes > 0 ? Math.min(100, Math.round((node.size_bytes / totalVolumeBytes) * 100)) : 0;
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div className={`space-y-1.5 ${depth > 0 ? "ml-3 sm:ml-5 pl-2.5 border-l border-[var(--border-divider)]" : ""}`}>
      <div className="bg-black/20 border border-[var(--border-card)] hover:border-[var(--border-subtle)] rounded-[4px] p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer p-0.5"
            >
              {expanded ? (
                <ChevronDown16Regular className="w-4 h-4 text-amber-400" />
              ) : (
                <ChevronRight16Regular className="w-4 h-4" />
              )}
            </button>
          ) : (
            <Folder20Regular className="w-4 h-4 text-amber-500/80 shrink-0 ml-0.5" />
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[var(--text-primary)] text-xs font-ibm-mono truncate">{node.name}</span>
              {node.is_system_protected && (
                <span className="px-1.5 py-0.2 rounded-[3px] text-xs font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25">
                  {t.storage.systemProtected}
                </span>
              )}
              {hasChildren && (
                <span className="px-1.5 py-0.2 rounded-[3px] text-xs font-medium bg-black/30 text-[var(--text-secondary)] border border-[var(--border-card)] font-ibm-mono">
                  {node.children.length} {t.storage.subHeavyCount}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-secondary)] font-ibm-mono truncate mt-0.5 select-all">{node.path}</p>
          </div>
        </div>

        <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 font-ibm-mono text-right">
          <div className="w-20 sm:w-24 bg-black/30 h-1.5 rounded-full overflow-hidden border border-[var(--border-subtle)] hidden sm:block">
            <div
              className="bg-amber-500 h-full rounded-full"
              style={{ width: `${Math.max(5, pct)}%` }}
            />
          </div>
          <div className="text-right w-24 sm:w-28">
            <div className="text-xs font-bold text-amber-400 tabular-nums">{formatBytes(node.size_bytes)}</div>
            <div className="text-xs text-[var(--text-muted)] tabular-nums">
              {node.file_count.toLocaleString()} {t.common.files}
            </div>
          </div>

          <button
            onClick={() => onOpenInExplorer(node.path)}
            title={t.common.openInExplorer}
            className="p-1.5 bg-black/20 hover:bg-amber-600 hover:text-white text-[var(--text-secondary)] rounded-[4px] transition-all border border-[var(--border-card)] cursor-pointer shrink-0"
          >
            <FolderOpen20Regular className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="space-y-1.5 mt-1.5">
          {node.children.map((child, idx) => (
            <HeavyFolderItem
              key={child.path || idx}
              node={child}
              totalVolumeBytes={totalVolumeBytes}
              formatBytes={formatBytes}
              onOpenInExplorer={onOpenInExplorer}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const StoragePage: React.FC = () => {
  const { t } = useI18nStore();
  const [volumes, setVolumes] = useState<StorageVolumeInfo[]>([]);
  const [selectedVolume, setSelectedVolume] = useState<string>("");
  const [treeData, setTreeData] = useState<StorageTreeNode | null>(null);
  const [scanning, setScanning] = useState<boolean>(false);
  const [maxDepth, setMaxDepth] = useState<number>(3);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"treemap" | "heavy">("treemap");

  // Heavy folders state
  const [heavyResult, setHeavyResult] = useState<HeavyFoldersScanResult | null>(null);
  const [scanningHeavy, setScanningHeavy] = useState<boolean>(false);
  const [heavyThreshold, setHeavyThreshold] = useState<number>(1024 * 1024 * 1024); // 1 GB default

  // Drill-down breadcrumb stack
  const [drillStack, setDrillStack] = useState<StorageTreeNode[]>([]);
  const [drilldownNode, setDrilldownNode] = useState<StorageTreeNode | null>(null);

  // Table filter & sort
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [tableSortBy, setTableSortBy] = useState<"size-desc" | "size-asc" | "name" | "items">("size-desc");

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  useEffect(() => {
    const loadVolumes = async () => {
      try {
        const vols = await invoke<StorageVolumeInfo[]>("get_storage_volumes");
        setVolumes(vols);
        if (vols.length > 0) {
          setSelectedVolume(vols[0].mount_point);
          setCurrentPath(vols[0].mount_point);
        }
      } catch (e) {
        console.error("Failed to load storage volumes:", e);
      }
    };
    loadVolumes();
  }, []);

  const handleScan = async (path?: string, depth = maxDepth) => {
    const target = path || currentPath || selectedVolume;
    if (!target) return;
    setScanning(true);
    try {
      const res = await invoke<StorageTreeNode>("scan_directory_storage", {
        path: target,
        maxDepth: depth,
      });
      setTreeData(res);
      setDrilldownNode(res);
      setDrillStack([res]);
      setFilterQuery("");
    } catch (e) {
      console.error("Failed to scan directory:", e);
    } finally {
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    try {
      await Promise.all([
        invoke("cancel_active_scan", { kind: "storage" }),
        invoke("cancel_active_scan", { kind: "heavy_folders" }),
      ]);
    } catch (e) {
      console.error("Failed to cancel scan:", e);
    } finally {
      setScanning(false);
      setScanningHeavy(false);
    }
  };

  const handleScanHeavy = async (threshold = heavyThreshold) => {
    const target = selectedVolume || currentPath;
    if (!target) return;
    setScanningHeavy(true);
    try {
      const res = await invoke<HeavyFoldersScanResult>("scan_heavy_folders", {
        root: target,
        minSizeBytes: threshold,
      });
      setHeavyResult(res);
    } catch (e) {
      console.error("Failed to scan heavy folders:", e);
    } finally {
      setScanningHeavy(false);
    }
  };

  const handleExport = async (format: "csv" | "json") => {
    if (!treeData) return;
    try {
      let content = "";
      let mimeType = "";

      if (format === "json") {
        content = JSON.stringify(treeData, null, 2);
        mimeType = "application/json";
      } else {
        const rows: string[] = ["Path,Name,Size (Bytes),Formatted Size,Files,Dirs,Protected,Type"];
        const traverse = (node: StorageTreeNode) => {
          rows.push(
            `"${node.path}","${node.name}",${node.size_bytes},"${formatBytes(node.size_bytes)}",${node.file_count},${node.dir_count},"${node.is_system_protected ? "Yes" : "No"}","${node.is_dir ? "Directory" : "File"}"`
          );
          if (node.children) {
            node.children.forEach(traverse);
          }
        };
        traverse(treeData);
        content = rows.join("\n");
        mimeType = "text/csv";
      }

      const blob = new Blob([content], {
        type: `${mimeType};charset=utf-8;`,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `freemydisk_storage_scan.${format}`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) {
      console.error("Export failed:", e);
    }
  };

  const handleOpenInExplorer = async (path?: string) => {
    const target = path || drilldownNode?.path || currentPath;
    if (!target) return;
    try {
      await revealItemInDir(target);
    } catch (e) {
      console.error("Failed to open path in explorer:", e);
    }
  };

  const drillInto = (node: StorageTreeNode) => {
    if (!node.is_dir) return;
    setDrilldownNode(node);
    setDrillStack((prev) => [...prev, node]);
    setFilterQuery("");
  };

  const goUpOneLevel = () => {
    if (drillStack.length > 1) {
      const nextStack = drillStack.slice(0, drillStack.length - 1);
      const parent = nextStack[nextStack.length - 1];
      setDrilldownNode(parent);
      setDrillStack(nextStack);
      setFilterQuery("");
    }
  };

  const jumpToStackIndex = (idx: number) => {
    if (idx >= 0 && idx < drillStack.length) {
      const target = drillStack[idx];
      setDrilldownNode(target);
      setDrillStack(drillStack.slice(0, idx + 1));
      setFilterQuery("");
    }
  };

  // Filtered & sorted children in current drilldown folder
  const filteredChildren = useMemo(() => {
    if (!drilldownNode || !drilldownNode.children) return [];
    let list = drilldownNode.children.filter((child) => {
      if (!filterQuery) return true;
      const q = filterQuery.toLowerCase();
      return child.name.toLowerCase().includes(q) || child.path.toLowerCase().includes(q);
    });

    list.sort((a, b) => {
      if (tableSortBy === "size-desc") return b.size_bytes - a.size_bytes;
      if (tableSortBy === "size-asc") return a.size_bytes - b.size_bytes;
      if (tableSortBy === "name") return a.name.localeCompare(b.name);
      if (tableSortBy === "items") return (b.file_count + b.dir_count) - (a.file_count + a.dir_count);
      return 0;
    });

    return list;
  }, [drilldownNode, filterQuery, tableSortBy]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <HardDrive24Filled className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.storage.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] bg-[#0078d4]/10 border border-[#0078d4]/25 text-[#0078d4] text-xs font-bold uppercase font-ibm-mono">
                {t.nav.storage}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.storage.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {treeData && (
            <div className="flex items-center gap-1 text-xs font-ibm-mono">
              <WinUIButton
                variant="subtle"
                onClick={() => handleExport("csv")}
                className="flex items-center gap-1"
              >
                <ArrowDownload20Regular className="w-3.5 h-3.5" /> CSV
              </WinUIButton>
              <WinUIButton
                variant="subtle"
                onClick={() => handleExport("json")}
                className="flex items-center gap-1"
              >
                <ArrowDownload20Regular className="w-3.5 h-3.5" /> JSON
              </WinUIButton>
            </div>
          )}

          {/* Depth selector */}
          <div className="flex items-center gap-1 bg-black/20 border border-[var(--border-card)] p-0.5 rounded-[4px] text-xs font-ibm-mono">
            <Layer20Regular className="w-3.5 h-3.5 text-[var(--text-muted)] ml-1 mr-0.5" />
            {[2, 3, 4].map((d) => (
              <button
                key={d}
                onClick={() => {
                  setMaxDepth(d);
                  handleScan(undefined, d);
                }}
                className={`px-2 py-0.5 rounded-[3px] text-xs font-bold cursor-pointer transition-all ${
                  maxDepth === d
                    ? "bg-[#0078d4] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                D{d}
              </button>
            ))}
          </div>

          {scanning && (
            <WinUIButton
              variant="danger"
              onClick={handleCancelScan}
              className="flex items-center gap-1"
            >
              <DismissCircle20Regular className="w-3.5 h-3.5" />
              <span>{t.common.cancelScan}</span>
            </WinUIButton>
          )}

          <WinUIButton
            variant="primary"
            onClick={() => handleScan()}
            disabled={scanning || !currentPath}
            className="flex items-center gap-1.5"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
            <span>{scanning ? t.common.scanning : t.storage.scanDirectory}</span>
          </WinUIButton>
        </div>
      </div>

      {/* Volume Selector Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {volumes.map((v) => {
          const usedBytes = v.total_bytes - v.available_bytes;
          const pct = Math.min(100, Math.round((usedBytes / (v.total_bytes || 1)) * 100));
          const isSelected = selectedVolume === v.mount_point;

          return (
            <WinUICard
              key={v.mount_point}
              onClick={() => {
                setSelectedVolume(v.mount_point);
                setCurrentPath(v.mount_point);
                handleScan(v.mount_point);
              }}
              className={`p-3.5 transition-all cursor-pointer ${
                isSelected
                  ? "border-[#0078d4] bg-[#0078d4]/[0.06] shadow-xs"
                  : "hover:border-[var(--border-subtle)]"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-xs text-[var(--text-primary)] flex items-center gap-2">
                  <span className="px-1.5 py-0.2 rounded-[3px] bg-[#0078d4]/20 text-[#0078d4] font-ibm-mono text-xs font-bold border border-[#0078d4]/30">
                    {v.mount_point}
                  </span>
                  {v.volume_name || t.common.drive}
                </span>
                <span className="text-xs px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-secondary)] font-ibm-mono border border-[var(--border-card)]">
                  {v.file_system}
                </span>
              </div>

              <div className="w-full bg-black/30 h-1.5 rounded-full overflow-hidden mb-2 border border-[var(--border-subtle)]">
                <div
                  className="bg-[#0078d4] h-full rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>

              <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs font-ibm-mono text-[var(--text-secondary)] tabular-nums">
                <span className="whitespace-nowrap">{t.common.usedSpace}: <strong className="text-[var(--text-primary)] whitespace-nowrap">{formatBytes(usedBytes)}</strong></span>
                <span className="whitespace-nowrap">{t.common.freeSpace}: <strong className="text-emerald-400 whitespace-nowrap">{formatBytes(v.available_bytes)}</strong></span>
              </div>
            </WinUICard>
          );
        })}
      </div>

      {/* View Switcher: Treemap vs Heavy Folders */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-divider)] pb-2.5">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setActiveTab("treemap")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-[4px] text-xs font-medium transition-all cursor-pointer ${
              activeTab === "treemap"
                ? "bg-[#0078d4] text-white"
                : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
            }`}
          >
            <DataPie20Regular className="w-3.5 h-3.5" />
            <span>{t.storage.tabTreemap}</span>
          </button>
          <button
            onClick={() => {
              setActiveTab("heavy");
              if (!heavyResult && !scanningHeavy) {
                handleScanHeavy();
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-[4px] text-xs font-medium transition-all cursor-pointer ${
              activeTab === "heavy"
                ? "bg-amber-600 text-white"
                : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
            }`}
          >
            <Folder20Regular className="w-3.5 h-3.5" />
            <span>{t.storage.tabHeavyFolders}</span>
          </button>
        </div>

        {activeTab === "heavy" && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-[var(--text-secondary)] font-ibm-mono">{t.storage.thresholdPreset}</span>
            {[
              { label: "500 MB", bytes: 500 * 1024 * 1024 },
              { label: "1 GB", bytes: 1024 * 1024 * 1024 },
              { label: "2 GB", bytes: 2 * 1024 * 1024 * 1024 },
              { label: "5 GB", bytes: 5 * 1024 * 1024 * 1024 },
              { label: "10 GB", bytes: 10 * 1024 * 1024 * 1024 },
            ].map((th) => (
              <button
                key={th.label}
                onClick={() => {
                  setHeavyThreshold(th.bytes);
                  handleScanHeavy(th.bytes);
                }}
                className={`px-2 py-0.5 rounded-[3px] text-xs font-ibm-mono font-medium cursor-pointer transition-all ${
                  heavyThreshold === th.bytes
                    ? "bg-amber-600 text-white"
                    : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
                }`}
              >
                {th.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeTab === "heavy" ? (
        <div className="space-y-3">
          <WinUICard className="p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-divider)] pb-3">
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                  <Folder20Filled className="w-4 h-4 text-amber-400" />
                  {t.storage.tabHeavyFolders} — {selectedVolume || "Drive"}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {t.storage.subtitle} (≥ {formatBytes(heavyThreshold)})
                </p>
              </div>

              <WinUIButton
                variant="standard"
                onClick={() => handleScanHeavy()}
                disabled={scanningHeavy}
                className="flex items-center gap-1.5 self-start sm:self-auto"
              >
                <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanningHeavy ? "animate-spin" : ""}`} />
                <span>{scanningHeavy ? t.storage.scanningHeavy : t.common.rescan}</span>
              </WinUIButton>
            </div>

            {scanningHeavy ? (
              <LiveScanProgressWidget
                scanType="heavy_folders"
                title={t.storage.scanningHeavy}
                subtitle={`Drive: ${selectedVolume || "C:\\"}`}
                onCancel={handleCancelScan}
              />
            ) : !heavyResult || heavyResult.heavy_folders.length === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center space-y-2 bg-black/20 rounded-[4px] border border-[var(--border-card)] text-center p-6">
                <Folder20Regular className="w-6 h-6 text-[var(--text-muted)]" />
                <p className="text-xs text-[var(--text-primary)] font-semibold">{t.storage.noHeavyFound}</p>
                <p className="text-xs text-[var(--text-secondary)]">
                  {t.storage.noHeavyDesc}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {heavyResult.heavy_folders.map((folder, idx) => {
                  const vol = volumes.find((v) => v.mount_point === selectedVolume);
                  return (
                    <HeavyFolderItem
                      key={folder.path || idx}
                      node={folder}
                      totalVolumeBytes={vol?.total_bytes || heavyResult.total_scanned_bytes}
                      formatBytes={formatBytes}
                      onOpenInExplorer={handleOpenInExplorer}
                    />
                  );
                })}
              </div>
            )}
          </WinUICard>
        </div>
      ) : (
        <>
          {/* Interactive Treemap Canvas Box */}
          <WinUICard className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold text-xs">
                <DataPie20Filled className="w-4 h-4 text-[#0078d4]" />
                <span>{t.storage.tabTreemap}</span>
                {drilldownNode && (
                  <span className="text-[var(--text-secondary)] font-ibm-mono text-xs font-normal">
                    — {drilldownNode.name} ({formatBytes(drilldownNode.size_bytes)})
                  </span>
                )}
              </div>
              <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                {t.storage.treemapTip}
              </span>
            </div>

            {scanning ? (
              <LiveScanProgressWidget
                scanType="storage"
                title={t.storage.scanningVisual}
                subtitle={`Path: ${currentPath}`}
                onCancel={handleCancelScan}
              />
            ) : drilldownNode && drilldownNode.children && drilldownNode.children.length > 0 ? (
              <TreemapCanvas
                data={drilldownNode}
                onSelectNode={(node) => {
                  if (node.is_dir) {
                    drillInto(node);
                  }
                }}
                onOpenExplorer={handleOpenInExplorer}
              />
            ) : (
              <div className="h-64 flex flex-col items-center justify-center space-y-2 bg-black/20 rounded-[4px] border border-[var(--border-card)] text-center p-6">
                <HardDrive20Regular className="w-6 h-6 text-[var(--text-muted)]" />
                <p className="text-xs text-[var(--text-primary)] font-semibold">{t.storage.readyTitle}</p>
                <p className="text-xs text-[var(--text-secondary)]">{t.storage.readyDesc}</p>
              </div>
            )}
          </WinUICard>

          {/* Directory Drill-down Explorer with Breadcrumbs */}
          {drilldownNode && (
            <WinUICard className="overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--border-divider)] flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-black/20">
                {/* Breadcrumbs with Up-One-Level Button */}
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] font-ibm-mono overflow-x-auto py-0.5">
                  {drillStack.length > 1 && (
                    <button
                      onClick={goUpOneLevel}
                      title="Up one level"
                      className="p-1 rounded-[3px] bg-black/20 hover:bg-white/[0.08] text-[var(--text-secondary)] hover:text-white border border-[var(--border-card)] cursor-pointer transition-colors shrink-0 mr-0.5"
                    >
                      <ChevronUp16Regular className="w-3.5 h-3.5 text-[#0078d4]" />
                    </button>
                  )}

                  {drillStack.map((stackItem, sIdx) => {
                    const isLast = sIdx === drillStack.length - 1;
                    return (
                      <React.Fragment key={stackItem.path + sIdx}>
                        <button
                          onClick={() => jumpToStackIndex(sIdx)}
                          className={`hover:text-[var(--text-primary)] transition-colors cursor-pointer ${
                            isLast ? "text-[var(--text-primary)] font-bold" : "text-[#0078d4] hover:underline"
                          }`}
                        >
                          {sIdx === 0 ? t.storage.parentFolder : stackItem.name}
                        </button>
                        {!isLast && <ChevronRight16Regular className="w-3 h-3 text-[var(--text-muted)] shrink-0" />}
                      </React.Fragment>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    onClick={() => handleOpenInExplorer(drilldownNode.path)}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-black/20 hover:bg-[#0078d4] hover:text-white text-[var(--text-primary)] text-xs font-medium rounded-[4px] border border-[var(--border-card)] transition-all cursor-pointer"
                  >
                    <FolderOpen20Regular className="w-3.5 h-3.5" />
                    <span>{t.common.openInExplorer}</span>
                  </button>

                  <div className="text-xs text-[var(--text-secondary)] font-ibm-mono tabular-nums">
                    Total: <strong className="text-[#0078d4]">{formatBytes(drilldownNode.size_bytes)}</strong> ({drilldownNode.children.length} {t.common.items})
                  </div>
                </div>
              </div>

              {/* In-folder filter and sorting controls */}
              <div className="px-4 py-2 bg-black/10 border-b border-[var(--border-divider)] flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
                <div className="relative w-full sm:w-64">
                  <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    placeholder="Filter items in current folder..."
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#0078d4]"
                  />
                </div>

                <div className="flex items-center gap-1.5 self-end sm:self-auto bg-black/20 px-2 py-1 rounded-[4px] border border-[var(--border-card)]">
                  <ArrowSort20Regular className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <select
                    value={tableSortBy}
                    onChange={(e) => setTableSortBy(e.target.value as any)}
                    className="bg-transparent text-[var(--text-primary)] text-xs font-medium focus:outline-none cursor-pointer"
                  >
                    <option value="size-desc" className="bg-[#202020] text-[var(--text-primary)]">Size: Largest</option>
                    <option value="size-asc" className="bg-[#202020] text-[var(--text-primary)]">Size: Smallest</option>
                    <option value="name" className="bg-[#202020] text-[var(--text-primary)]">Name: A-Z</option>
                    <option value="items" className="bg-[#202020] text-[var(--text-primary)]">Items count</option>
                  </select>
                </div>
              </div>

              {/* Items List */}
              <div className="divide-y divide-[var(--border-divider)] max-h-80 overflow-y-auto">
                {filteredChildren.map((child, idx) => {
                  const pct = drilldownNode.size_bytes
                    ? ((child.size_bytes / drilldownNode.size_bytes) * 100).toFixed(1)
                    : "0";

                  return (
                    <div
                      key={child.path + idx}
                      onClick={() => child.is_dir && drillInto(child)}
                      className={`px-4 py-2.5 flex items-center justify-between text-xs hover:bg-white/[0.02] transition-colors ${
                        child.is_dir ? "cursor-pointer" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2.5 flex-1 min-w-0 mr-3">
                        {child.is_dir ? (
                          <Folder20Regular className="w-4 h-4 text-[#0078d4] shrink-0" />
                        ) : (
                          <Document20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                        )}
                        <span className="font-ibm-mono text-[var(--text-primary)] truncate">{child.name}</span>
                        {child.is_system_protected && (
                          <span className="px-1.5 py-0.2 rounded-[3px] text-xs font-bold bg-amber-500/15 text-amber-300 border border-amber-500/25 font-ibm-mono shrink-0">
                            Protected
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 shrink-0 font-ibm-mono tabular-nums">
                        <div className="w-20 bg-black/30 h-1 rounded-full overflow-hidden border border-[var(--border-subtle)] hidden sm:block">
                          <div className="bg-[#0078d4] h-full rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[var(--text-muted)] w-10 text-right">{pct}%</span>
                        <span className="font-semibold text-[var(--text-primary)] w-20 text-right">
                          {formatBytes(child.size_bytes)}
                        </span>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenInExplorer(child.path);
                          }}
                          title="Show in File Explorer"
                          className="p-1 bg-black/20 hover:bg-[#0078d4] hover:text-white text-[var(--text-secondary)] rounded-[4px] transition-all border border-[var(--border-card)] cursor-pointer"
                        >
                          <FolderOpen20Regular className="w-3.5 h-3.5" />
                        </button>

                        {child.is_dir && <ChevronRight16Regular className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </WinUICard>
          )}
        </>
      )}
    </div>
  );
};

export default StoragePage;
