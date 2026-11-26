import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { TreemapCanvas, StorageTreeNode } from "@/components/storage/TreemapCanvas";
import { useI18nStore } from "@/i18n";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, Badge, ProgressBar, FilterTabs, EmptyState } from "@/components/ui";
import {
  HardDrive20Regular,
  Folder20Regular,
  Document20Regular,
  ArrowDownload20Regular,
  ChevronRight16Regular,
  ChevronDown16Regular,
  ArrowUp16Regular,
  ArrowClockwise20Regular,
  DataTreemap20Regular,
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

/** Fills `{name}` placeholders in a translated string. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** Like `fill`, but each value is a React node (so values can be styled / kept from wrapping). */
const fillNodes = (template: string, vars: Record<string, React.ReactNode>): React.ReactNode[] =>
  template.split(/(\{\w+\})/g).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    return <React.Fragment key={i}>{m && m[1] in vars ? vars[m[1]] : part}</React.Fragment>;
  });

const HEAVY_THRESHOLDS = [
  { label: "500 MB", bytes: 500 * 1024 * 1024 },
  { label: "1 GB", bytes: 1024 * 1024 * 1024 },
  { label: "2 GB", bytes: 2 * 1024 * 1024 * 1024 },
  { label: "5 GB", bytes: 5 * 1024 * 1024 * 1024 },
  { label: "10 GB", bytes: 10 * 1024 * 1024 * 1024 },
];

const controlClass =
  "h-8 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]";

/** Compact segmented look for FilterTabs used as a control. */
const segmentedClass =
  "rounded-md border border-[var(--border-card)] p-0.5 gap-0.5 [&>button]:h-7 [&>button]:px-2.5";

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
    <>
      <div
        className="pr-4 py-3 flex items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
        style={{ paddingLeft: 16 + depth * 24 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="w-6 h-6 shrink-0 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--fill-subtle-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            {expanded ? <ChevronDown16Regular className="w-4 h-4" /> : <ChevronRight16Regular className="w-4 h-4" />}
          </button>
        ) : (
          <span className="w-6 h-6 shrink-0 flex items-center justify-center text-[var(--text-secondary)]">
            <Folder20Regular className="w-4 h-4" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-[var(--text-primary)] truncate" title={node.name}>
              {node.name}
            </span>
            {node.is_system_protected && <Badge tone="warning" className="shrink-0">{t.storage.systemProtected}</Badge>}
            {hasChildren && (
              <Badge className="shrink-0">
                <span className="font-ibm-mono">{node.children.length}</span> {t.storage.subHeavyCount}
              </Badge>
            )}
          </div>
          <div className="font-code text-xs text-[var(--text-muted)] truncate mt-0.5 select-all" title={node.path}>
            {node.path}
          </div>
        </div>

        <div className="w-28 sm:w-32 shrink-0 flex flex-col items-end gap-1">
          <span className="text-sm font-ibm-mono tabular-nums text-[var(--text-primary)] whitespace-nowrap">
            {formatBytes(node.size_bytes)}
          </span>
          <ProgressBar value={Math.max(3, pct)} />
          <span className="text-xs text-[var(--text-muted)] tabular-nums whitespace-nowrap">
            {node.file_count.toLocaleString()} {t.common.files}
          </span>
        </div>

        <span title={t.common.openInExplorer} className="shrink-0">
          <WinUIButton
            variant="subtle"
            size="sm"
            className="w-8 !px-0"
            aria-label={t.common.openInExplorer}
            onClick={() => onOpenInExplorer(node.path)}
            icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
          />
        </span>
      </div>

      {expanded &&
        hasChildren &&
        node.children.map((child, idx) => (
          <HeavyFolderItem
            key={child.path || idx}
            node={child}
            totalVolumeBytes={totalVolumeBytes}
            formatBytes={formatBytes}
            onOpenInExplorer={onOpenInExplorer}
            depth={depth + 1}
          />
        ))}
    </>
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

  // Live progress from the backend (storage and heavy-folder scans).
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

  const nowrap = (v: React.ReactNode) => <span className="whitespace-nowrap">{v}</span>;

  return (
    <Page className="select-none">
      <PageHeader
        icon={<HardDrive20Regular />}
        title={t.nav.storage}
        description={t.storage.pageDesc}
        actions={
          <>
            <div className="flex items-center gap-1.5" title={t.storage.depthTitle}>
              <Layer20Regular className="w-4 h-4 text-[var(--text-muted)]" />
              <FilterTabs
                items={[2, 3, 4].map((d) => ({ id: String(d), label: <span className="font-ibm-mono">D{d}</span> }))}
                value={String(maxDepth)}
                onChange={(id) => {
                  const d = Number(id);
                  setMaxDepth(d);
                  handleScan(undefined, d);
                }}
                className={segmentedClass}
              />
            </div>
            <WinUIButton
              variant="primary"
              onClick={() => handleScan()}
              disabled={scanning || !currentPath}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
            >
              {scanning ? t.common.scanning : treeData ? t.common.rescan : t.common.scan}
            </WinUIButton>
          </>
        }
      />

      {/* Drives */}
      {volumes.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {volumes.map((v) => {
            const usedBytes = v.total_bytes - v.available_bytes;
            const pct = Math.min(100, Math.round((usedBytes / (v.total_bytes || 1)) * 100));
            const freePct = v.total_bytes > 0 ? (v.available_bytes / v.total_bytes) * 100 : 100;
            const isSelected = selectedVolume === v.mount_point;

            return (
              <Card
                key={v.mount_point}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => {
                  setSelectedVolume(v.mount_point);
                  setCurrentPath(v.mount_point);
                  handleScan(v.mount_point);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedVolume(v.mount_point);
                    setCurrentPath(v.mount_point);
                    handleScan(v.mount_point);
                  }
                }}
                className={`min-w-0 space-y-3 cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)] focus:outline-none focus-visible:!border-[var(--accent)] ${
                  isSelected ? "!border-[var(--accent)]" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <HardDrive20Regular
                      className={`w-5 h-5 shrink-0 ${isSelected ? "text-[var(--accent-text)]" : "text-[var(--text-secondary)]"}`}
                    />
                    <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                      {v.volume_name || t.common.drive}
                    </span>
                    {!(v.volume_name || "").includes(v.mount_point.replace(/[\\/]+$/, "")) && (
                      <span className="text-sm font-ibm-mono text-[var(--text-secondary)] shrink-0">
                        {v.mount_point.replace(/[\\/]+$/, "")}
                      </span>
                    )}
                  </div>
                  <Badge className="font-ibm-mono shrink-0">{v.file_system}</Badge>
                </div>

                <ProgressBar value={pct} tone={freePct < 15 ? "danger" : "accent"} />

                <div
                  className="text-sm font-ibm-mono tabular-nums text-[var(--text-secondary)]"
                  title={`${t.common.usedSpace}: ${formatBytes(usedBytes)} · ${t.common.freeSpace}: ${formatBytes(v.available_bytes)}`}
                >
                  {fillNodes(t.storage.driveUsage, {
                    used: nowrap(<span className="text-[var(--text-primary)]">{formatBytes(usedBytes)}</span>),
                    free: nowrap(
                      <span className={freePct < 15 ? "text-[var(--danger)]" : "text-[var(--text-primary)]"}>
                        {formatBytes(v.available_bytes)}
                      </span>
                    ),
                    total: nowrap(formatBytes(v.total_bytes)),
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* View switcher, plus the size filter for heavy folders */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <FilterTabs
          items={[
            { id: "treemap" as const, label: t.storage.viewTreemap },
            {
              id: "heavy" as const,
              label: t.storage.viewHeavy,
              count: fill(t.storage.heavyAtLeast, { size: formatBytes(heavyThreshold) }),
            },
          ]}
          value={activeTab}
          onChange={(id) => {
            setActiveTab(id);
            if (id === "heavy" && !heavyResult && !scanningHeavy) {
              handleScanHeavy();
            }
          }}
        />

        {activeTab === "heavy" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-secondary)] whitespace-nowrap">{t.storage.thresholdPreset}</span>
            <FilterTabs
              items={HEAVY_THRESHOLDS.map((th) => ({
                id: String(th.bytes),
                label: <span className="font-ibm-mono">{th.label}</span>,
              }))}
              value={String(heavyThreshold)}
              onChange={(id) => {
                const bytes = Number(id);
                setHeavyThreshold(bytes);
                handleScanHeavy(bytes);
              }}
              className={segmentedClass}
            />
          </div>
        )}
      </div>

      {activeTab === "heavy" ? (
        scanningHeavy ? (
          <ScanProgressCard
            scanType="heavy_folders"
            title={t.storage.scanningHeavy}
            subtitle={fill(t.storage.scanDrive, { drive: selectedVolume || "C:\\" })}
            onCancel={handleCancelScan}
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-[var(--border-divider)]">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                  {fill(t.storage.heavyTitle, { drive: selectedVolume || t.common.drive })}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {fill(t.storage.heavyDesc, { size: formatBytes(heavyThreshold) })}
                  {heavyResult &&
                    heavyResult.heavy_folders.length > 0 &&
                    ` · ${heavyResult.heavy_folders.length} ${t.storage.foldersFound}`}
                </p>
              </div>
              <WinUIButton
                variant="standard"
                size="sm"
                onClick={() => handleScanHeavy()}
                disabled={scanningHeavy}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanningHeavy ? "animate-spin" : ""}`} />}
              >
                {scanningHeavy ? t.storage.scanningHeavy : t.common.rescan}
              </WinUIButton>
            </div>

            {!heavyResult || heavyResult.heavy_folders.length === 0 ? (
              <div className="py-12 px-6 flex flex-col items-center text-center gap-2">
                <Folder20Regular className="w-8 h-8 text-[var(--text-muted)]" />
                <div className="text-base font-semibold text-[var(--text-primary)]">{t.storage.noHeavyFound}</div>
                <div className="text-sm text-[var(--text-secondary)] max-w-md">{t.storage.noHeavyDesc}</div>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-divider)]">
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
          </Card>
        )
      ) : scanning ? (
        <ScanProgressCard
          scanType="storage"
          title={t.storage.scanningVisual}
          subtitle={fill(t.storage.scanPath, { path: currentPath })}
          onCancel={handleCancelScan}
        />
      ) : !drilldownNode ? (
        <EmptyState
          icon={<DataTreemap20Regular />}
          title={t.storage.readyTitle}
          description={t.storage.readyDesc}
          action={
            <WinUIButton
              variant="primary"
              size="lg"
              onClick={() => handleScan()}
              disabled={!currentPath}
              icon={<Search20Regular className="w-4 h-4" />}
            >
              {t.storage.startTreemapScan}
            </WinUIButton>
          }
        />
      ) : (
        <>
          {/* Treemap with its breadcrumb bar */}
          <Card padded={false} className="overflow-hidden">
            <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--border-divider)]">
              <nav className="flex items-center gap-1 text-sm min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {drillStack.length > 1 && (
                  <span title={t.storage.upOneLevel} className="shrink-0 mr-1">
                    <WinUIButton
                      variant="subtle"
                      size="sm"
                      className="w-8 !px-0"
                      aria-label={t.storage.upOneLevel}
                      onClick={goUpOneLevel}
                      icon={<ArrowUp16Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                    />
                  </span>
                )}

                {drillStack.map((stackItem, sIdx) => {
                  const isLast = sIdx === drillStack.length - 1;
                  return (
                    <React.Fragment key={stackItem.path + sIdx}>
                      {isLast ? (
                        <span
                          className="font-code text-[var(--text-primary)] font-semibold whitespace-nowrap"
                          title={stackItem.path}
                        >
                          {sIdx === 0 ? stackItem.path || t.storage.parentFolder : stackItem.name}
                        </span>
                      ) : (
                        <button
                          onClick={() => jumpToStackIndex(sIdx)}
                          title={stackItem.path}
                          className="px-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] whitespace-nowrap cursor-pointer transition-colors"
                        >
                          {sIdx === 0 ? stackItem.path || t.storage.parentFolder : stackItem.name}
                        </button>
                      )}
                      {!isLast && <ChevronRight16Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />}
                    </React.Fragment>
                  );
                })}
              </nav>

              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm font-ibm-mono tabular-nums text-[var(--text-secondary)] whitespace-nowrap">
                  {fill(t.storage.folderTotal, {
                    size: formatBytes(drilldownNode.size_bytes),
                    count: drilldownNode.children.length,
                  })}
                </span>
                <WinUIButton
                  variant="subtle"
                  size="sm"
                  onClick={() => handleOpenInExplorer(drilldownNode.path)}
                  icon={<FolderOpen20Regular className="w-4 h-4" />}
                >
                  {t.common.openInExplorer}
                </WinUIButton>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {drilldownNode.children && drilldownNode.children.length > 0 ? (
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
                <div className="py-12 flex flex-col items-center text-center gap-2">
                  <HardDrive20Regular className="w-8 h-8 text-[var(--text-muted)]" />
                  <div className="text-sm text-[var(--text-secondary)] max-w-md">{t.storage.emptyFolder}</div>
                </div>
              )}
              <p className="text-xs text-[var(--text-muted)]">{t.storage.treemapTip}</p>
            </div>
          </Card>

          {/* Folder contents: filter, sort and the item list */}
          <Card padded={false} className="overflow-hidden">
            <div className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--border-divider)]">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-[var(--text-primary)]">{t.storage.contents}</span>
                <span className="text-xs text-[var(--text-muted)] font-ibm-mono">{filteredChildren.length}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 sm:w-56 sm:flex-none">
                  <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
                  <input
                    type="text"
                    placeholder={t.storage.filterPlaceholder}
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    className={`${controlClass} w-full pl-8 pr-3 placeholder-[var(--text-muted)] select-text`}
                  />
                </div>
                <div className="relative">
                  <ArrowSort20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
                  <select
                    value={tableSortBy}
                    onChange={(e) => setTableSortBy(e.target.value as any)}
                    className={`${controlClass} pl-8 pr-2 cursor-pointer`}
                  >
                    <option value="size-desc" className="bg-[var(--bg-card)]">{t.storage.sortSizeDesc}</option>
                    <option value="size-asc" className="bg-[var(--bg-card)]">{t.storage.sortSizeAsc}</option>
                    <option value="name" className="bg-[var(--bg-card)]">{t.storage.sortName}</option>
                    <option value="items" className="bg-[var(--bg-card)]">{t.storage.sortItems}</option>
                  </select>
                </div>
                {treeData && (
                  <div className="flex items-center gap-1" title={t.storage.export}>
                    <WinUIButton
                      variant="subtle"
                      size="sm"
                      onClick={() => handleExport("csv")}
                      icon={<ArrowDownload20Regular className="w-4 h-4" />}
                    >
                      CSV
                    </WinUIButton>
                    <WinUIButton
                      variant="subtle"
                      size="sm"
                      onClick={() => handleExport("json")}
                      icon={<ArrowDownload20Regular className="w-4 h-4" />}
                    >
                      JSON
                    </WinUIButton>
                  </div>
                )}
              </div>
            </div>

            <div className="divide-y divide-[var(--border-divider)] max-h-96 overflow-y-auto">
              {filteredChildren.map((child, idx) => {
                const pct = drilldownNode.size_bytes
                  ? ((child.size_bytes / drilldownNode.size_bytes) * 100).toFixed(1)
                  : "0";

                return (
                  <div
                    key={child.path + idx}
                    onClick={() => child.is_dir && drillInto(child)}
                    className={`px-4 py-3 flex items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors ${
                      child.is_dir ? "cursor-pointer" : ""
                    }`}
                  >
                    <span className="w-8 h-8 shrink-0 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)]">
                      {child.is_dir ? <Folder20Regular className="w-4 h-4" /> : <Document20Regular className="w-4 h-4" />}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-[var(--text-primary)] truncate" title={child.name}>
                          {child.name}
                        </span>
                        {child.is_system_protected && (
                          <Badge tone="warning" className="shrink-0">{t.storage.protected}</Badge>
                        )}
                      </div>
                      <div className="font-code text-xs text-[var(--text-muted)] truncate mt-0.5" title={child.path}>
                        {child.path}
                      </div>
                    </div>

                    <span className="hidden sm:block w-12 shrink-0 text-right text-xs text-[var(--text-muted)] font-ibm-mono tabular-nums">
                      {pct}%
                    </span>
                    <div className="w-28 shrink-0 flex flex-col items-end gap-1">
                      <span className="text-sm font-ibm-mono tabular-nums text-[var(--text-primary)] whitespace-nowrap">
                        {formatBytes(child.size_bytes)}
                      </span>
                      <ProgressBar value={Number(pct)} />
                    </div>

                    <span title={t.common.openInExplorer} className="shrink-0">
                      <WinUIButton
                        variant="subtle"
                        size="sm"
                        className="w-8 !px-0"
                        aria-label={t.common.openInExplorer}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenInExplorer(child.path);
                        }}
                        icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                      />
                    </span>

                    <span className="w-4 shrink-0 text-[var(--text-muted)]">
                      {child.is_dir && <ChevronRight16Regular className="w-4 h-4" />}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </Page>
  );
};

export default StoragePage;

/** Live progress of a backend scan: bar, current path, item count, optional Cancel. */
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
          {subtitle && (
            <div className="text-xs text-[var(--text-secondary)] mt-0.5 truncate" title={subtitle}>
              {subtitle}
            </div>
          )}
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
          {progress.currentPath || t.storage.preparingScan}
        </span>
        <span className="shrink-0 tabular-nums">
          {fill(t.storage.itemsChecked, { count: progress.itemsScanned.toLocaleString() })}
          {progress.bytesFound > 0 && ` · ${fill(t.storage.bytesFound, { size: fmt(progress.bytesFound) })}`}
        </span>
      </div>
    </Card>
  );
};
