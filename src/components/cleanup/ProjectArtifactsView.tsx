import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import { toast } from "@/stores/toast-store";
import { useI18nStore } from "@/i18n";
import {
  Code20Regular,
  Folder20Regular,
  FolderOpen16Regular,
  Delete20Regular,
  ArrowClockwise20Regular,
  CheckmarkCircle20Filled,
  Clock20Regular,
  Wrench20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
} from "@fluentui/react-icons";
import { describeDisposal } from "@/utils/disposal";

export interface ProjectArtifact {
  path: string;
  relative_path: string;
  category: string;
  size_bytes: number;
  item_count: number;
  risk: string;
  verified_rebuildable: boolean;
  rebuild_command?: string;
  staleness_days: number;
  selected: boolean;
}

export interface ProjectMatch {
  project_root: string;
  project_type: string;
  project_name: string;
  artifacts: ProjectArtifact[];
  total_reclaimable_bytes: number;
  last_modified_days_ago: number;
}

export interface ProjectArtifactScanResult {
  total_projects: number;
  total_artifacts: number;
  total_reclaimable_bytes: number;
  projects: ProjectMatch[];
  scan_duration_ms: number;
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

export const ProjectArtifactsView: React.FC = () => {
  const { t } = useI18nStore();
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [scanResult, setScanResult] = useState<ProjectArtifactScanResult | null>(null);
  const [minSizeMb, setMinSizeMb] = useState<number>(5);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [disposalSummary, setDisposalSummary] = useState<DisposalSummary | null>(null);
  const [filterType, setFilterType] = useState<string>("all");

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const handleScan = async () => {
    setScanning(true);
    setDisposalSummary(null);
    try {
      const res = await invoke<ProjectArtifactScanResult>("scan_project_artifacts", {
        minSizeBytes: minSizeMb * 1024 * 1024,
      });
      setScanResult(res);
      // Auto-expand top 5 projects
      const topIds = new Set(res.projects.slice(0, 5).map((p) => p.project_root));
      setExpandedProjects(topIds);
    } catch (e: any) {
      const errStr = String(e || "");
      if (!errStr.toLowerCase().includes("cancel")) {
        console.error("Project scan error:", e);
        toast.error("Scan Failed", String(e));
      }
    } finally {
      setScanning(false);
    }
  };

  const toggleExpand = (root: string) => {
    const next = new Set(expandedProjects);
    if (next.has(root)) next.delete(root);
    else next.add(root);
    setExpandedProjects(next);
  };

  const toggleArtifactSelected = (projectRoot: string, artifactPath: string) => {
    if (!scanResult) return;
    const nextProjects = scanResult.projects.map((proj) => {
      if (proj.project_root !== projectRoot) return proj;
      return {
        ...proj,
        artifacts: proj.artifacts.map((art) => {
          if (art.path !== artifactPath) return art;
          return { ...art, selected: !art.selected };
        }),
      };
    });
    setScanResult({ ...scanResult, projects: nextProjects });
  };

  const selectStaleOnly = (daysThreshold = 30) => {
    if (!scanResult) return;
    const nextProjects = scanResult.projects.map((proj) => ({
      ...proj,
      artifacts: proj.artifacts.map((art) => ({
        ...art,
        selected: art.staleness_days >= daysThreshold && art.risk === "safe",
      })),
    }));
    setScanResult({ ...scanResult, projects: nextProjects });
  };

  const selectAllSafe = () => {
    if (!scanResult) return;
    const nextProjects = scanResult.projects.map((proj) => ({
      ...proj,
      artifacts: proj.artifacts.map((art) => ({
        ...art,
        selected: art.risk === "safe" && art.verified_rebuildable,
      })),
    }));
    setScanResult({ ...scanResult, projects: nextProjects });
  };

  const deselectAll = () => {
    if (!scanResult) return;
    const nextProjects = scanResult.projects.map((proj) => ({
      ...proj,
      artifacts: proj.artifacts.map((art) => ({
        ...art,
        selected: false,
      })),
    }));
    setScanResult({ ...scanResult, projects: nextProjects });
  };

  const selectedArtifacts = scanResult
    ? scanResult.projects.flatMap((p) => p.artifacts.filter((a) => a.selected))
    : [];

  const totalSelectedBytes = selectedArtifacts.reduce((acc, a) => acc + a.size_bytes, 0);

  const handleCleanSelected = async () => {
    if (selectedArtifacts.length === 0 || !scanResult) return;
    setCleaning(true);
    try {
      const paths = selectedArtifacts.map((a) => a.path);
      const summary = await invoke<DisposalSummary>("clean_project_artifacts", {
        artifactPaths: paths,
      });
      setDisposalSummary(summary);

      const normalize = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const failedSet = new Set((summary.failed_trash_paths || []).map(normalize));
      const successfulSet = new Set(paths.filter((p) => !failedSet.has(normalize(p))).map(normalize));

      const nextProjects = scanResult.projects
        .map((proj) => {
          const remaining = proj.artifacts.filter((a) => !successfulSet.has(normalize(a.path)));
          const totalReclaimable = remaining.reduce((acc, a) => acc + a.size_bytes, 0);
          return {
            ...proj,
            artifacts: remaining,
            total_reclaimable_bytes: totalReclaimable,
          };
        })
        .filter((p) => p.artifacts.length > 0);

      const totalArtifacts = nextProjects.reduce((acc, p) => acc + p.artifacts.length, 0);
      const totalReclaimableBytes = nextProjects.reduce((acc, p) => acc + p.total_reclaimable_bytes, 0);

      setScanResult({
        ...scanResult,
        total_projects: nextProjects.length,
        total_artifacts: totalArtifacts,
        total_reclaimable_bytes: totalReclaimableBytes,
        projects: nextProjects,
      });

      toast.success(
        "Artifacts Recycled",
        `${summary.successful_items} ${t.common.items} · ${describeDisposal(summary, t, formatBytes)}`
      );
    } catch (e) {
      console.error("Cleanup error:", e);
      toast.error("Cleanup Failed", String(e));
    } finally {
      setCleaning(false);
    }
  };

  const handleReveal = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (e) {
      console.error("Failed to reveal:", e);
    }
  };

  const projectTypes = scanResult
    ? Array.from(new Set(scanResult.projects.map((p) => p.project_type)))
    : [];

  const filteredProjects = scanResult
    ? scanResult.projects.filter(
        (p) => filterType === "all" || p.project_type === filterType
      )
    : [];

  return (
    <div className="space-y-4">
      {/* Action Header Card */}
      <WinUICard className="p-4 space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-[6px] bg-[#0078d4]/10 border border-[#0078d4]/20 flex items-center justify-center shrink-0">
              <Code20Regular className="w-5 h-5 text-[#0078d4]" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {t.projectArtifacts.title}
              </h3>
              <p className="text-xs text-[var(--text-secondary)]">
                {t.projectArtifacts.subtitle}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] bg-black/20 border border-[var(--border-card)] text-xs text-[var(--text-secondary)]">
              <span>{t.projectArtifacts.threshold}</span>
              <select
                value={minSizeMb}
                onChange={(e) => setMinSizeMb(Number(e.target.value))}
                className="bg-transparent text-[var(--text-primary)] font-ibm-mono text-xs focus:outline-none cursor-pointer"
              >
                <option value={1} className="bg-[#202020] text-white">≥ 1 MB</option>
                <option value={5} className="bg-[#202020] text-white">≥ 5 MB</option>
                <option value={20} className="bg-[#202020] text-white">≥ 20 MB</option>
                <option value={100} className="bg-[#202020] text-white">≥ 100 MB</option>
              </select>
            </div>

            <WinUIButton
              variant="primary"
              onClick={handleScan}
              disabled={scanning || cleaning}
              className="flex items-center gap-1.5"
            >
              <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
              <span>{scanning ? t.projectArtifacts.scanning : t.projectArtifacts.scanButton}</span>
            </WinUIButton>

            {selectedArtifacts.length > 0 && (
              <WinUIButton
                variant="danger"
                onClick={handleCleanSelected}
                disabled={cleaning || scanning}
                className="flex items-center gap-1.5"
              >
                <Delete20Regular className="w-3.5 h-3.5" />
                <span>
                  {cleaning
                    ? t.common.deleting
                    : `${t.projectArtifacts.cleanSelected} (${selectedArtifacts.length}) • ${formatBytes(totalSelectedBytes)}`}
                </span>
              </WinUIButton>
            )}
          </div>
        </div>

        {/* Quick Selection Toolbar (when results exist) */}
        {scanResult && scanResult.projects.length > 0 && (
          <div className="pt-2 border-t border-[var(--border-card)] flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-secondary)]">{t.common.filter}</span>
              <button
                onClick={() => selectStaleOnly(30)}
                className="px-2 py-0.5 rounded-[3px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-medium cursor-pointer transition-colors"
              >
                {t.projectArtifacts.selectDormant}
              </button>
              <button
                onClick={selectAllSafe}
                className="px-2 py-0.5 rounded-[3px] bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 font-medium cursor-pointer transition-colors"
              >
                {t.projectArtifacts.selectAll}
              </button>
              <button
                onClick={deselectAll}
                className="px-2 py-0.5 rounded-[3px] bg-white/[0.06] hover:bg-white/[0.1] text-[var(--text-secondary)] cursor-pointer transition-colors"
              >
                {t.projectArtifacts.clearSelection}
              </button>
            </div>

            {projectTypes.length > 1 && (
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--text-secondary)]">{t.common.filter}:</span>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="bg-black/20 border border-[var(--border-card)] rounded-[3px] px-2 py-0.5 text-xs text-[var(--text-primary)] focus:outline-none cursor-pointer"
                >
                  <option value="all" className="bg-[#202020]">{t.projectArtifacts.filterAll} ({scanResult.projects.length})</option>
                  {projectTypes.map((tItem) => (
                    <option key={tItem} value={tItem} className="bg-[#202020]">
                      {tItem.replace("project_", "").toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </WinUICard>

      {/* Disposal Summary Notification */}
      {disposalSummary && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
            <div>
              <div className="text-xs font-semibold text-emerald-400">{t.projectArtifacts.cleanupCompleteTitle}</div>
              <div className="text-xs text-emerald-400/80 font-ibm-mono tabular-nums">
                {disposalSummary.successful_items} {t.common.items} • {describeDisposal(disposalSummary, t, formatBytes)}
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

      {/* Stats Summary Bar */}
      {scanResult && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <WinUICard className="p-3">
            <div className="text-xs text-[var(--text-secondary)]">{t.projectArtifacts.discoveredProjects}</div>
            <div className="text-xl font-bold font-ibm-mono text-[var(--text-primary)] mt-1">
              {scanResult.total_projects}
            </div>
          </WinUICard>
          <WinUICard className="p-3">
            <div className="text-xs text-[var(--text-secondary)]">{t.projectArtifacts.reclaimableArtifacts}</div>
            <div className="text-xl font-bold font-ibm-mono text-[#0078d4] mt-1">
              {scanResult.total_artifacts}
            </div>
          </WinUICard>
          <WinUICard className="p-3">
            <div className="text-xs text-[var(--text-secondary)]">{t.projectArtifacts.totalReclaimableSpace}</div>
            <div className="text-xl font-bold font-ibm-mono text-emerald-400 mt-1">
              {formatBytes(scanResult.total_reclaimable_bytes)}
            </div>
          </WinUICard>
        </div>
      )}

      {/* Progress Telemetry */}
      {scanning ? (
        <LiveScanProgressWidget
          scanType="projects"
          title={t.projectArtifacts.scanning}
          subtitle="Searching for software build artifacts (node_modules, target, .gradle, bin, obj)..."
        />
      ) : cleaning ? (
        <LiveScanProgressWidget
          scanType="disposal"
          title="Cleaning developer build artifacts..."
          subtitle="Recycling selected project build folders"
          showCancel={false}
        />
      ) : null}

      {/* Project Matches List */}
      {!scanning && scanResult && filteredProjects.length > 0 && (
        <div className="space-y-2">
          {filteredProjects.map((project) => {
            const isExpanded = expandedProjects.has(project.project_root);
            const typeLabel = project.project_type.replace("project_", "").toUpperCase();

            return (
              <WinUICard key={project.project_root} className="overflow-hidden">
                <div
                  onClick={() => toggleExpand(project.project_root)}
                  className="p-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <button className="text-[var(--text-secondary)] p-0.5">
                      {isExpanded ? (
                        <ChevronDown16Regular className="w-4 h-4" />
                      ) : (
                        <ChevronRight16Regular className="w-4 h-4" />
                      )}
                    </button>
                    <Folder20Regular className="w-4 h-4 text-[#0078d4] shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
                          {project.project_name}
                        </span>
                        <span className="text-xs uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-[3px] bg-white/[0.08] text-[var(--text-secondary)]">
                          {typeLabel}
                        </span>
                        {project.last_modified_days_ago > 30 && (
                          <span className="flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 px-1.5 py-0.5 rounded-[3px]">
                            <Clock20Regular className="w-3 h-3" />
                            {project.last_modified_days_ago} {t.projectArtifacts.daysAgo} ({t.projectArtifacts.dormantBadge})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--text-secondary)] font-ibm-mono truncate mt-0.5 opacity-80">
                        {project.project_root}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs font-ibm-mono font-semibold text-emerald-400">
                      {formatBytes(project.total_reclaimable_bytes)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReveal(project.project_root);
                      }}
                      className="p-1 text-[var(--text-secondary)] hover:text-white rounded-[3px] hover:bg-white/[0.06] transition-colors"
                      title={t.projectArtifacts.revealInExplorer}
                    >
                      <FolderOpen16Regular className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-[var(--border-card)] bg-black/20 p-2 space-y-1.5">
                    {project.artifacts.map((art) => (
                      <div
                        key={art.path}
                        onClick={() => toggleArtifactSelected(project.project_root, art.path)}
                        className="flex items-center justify-between p-2 rounded-[4px] hover:bg-white/[0.03] text-xs cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={art.selected}
                            onChange={() => {}}
                            className="rounded-[3px] accent-[#0078d4] cursor-pointer"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-ibm-mono font-semibold text-[var(--text-primary)]">
                                {art.relative_path}
                              </span>
                              <span className="text-xs px-1 py-0.2 rounded-[2px] bg-white/[0.05] text-[var(--text-secondary)] capitalize">
                                {art.category}
                              </span>
                              {art.rebuild_command && (
                                <span
                                  className="flex items-center gap-1 text-xs text-blue-300 font-ibm-mono bg-blue-500/10 px-1 py-0.2 rounded-[2px]"
                                  title={t.projectArtifacts.rebuildCommand}
                                >
                                  <Wrench20Regular className="w-2.5 h-2.5" />
                                  {art.rebuild_command}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--text-secondary)] font-ibm-mono truncate mt-0.5">
                              {art.item_count} {t.common.files} • {art.staleness_days} {t.projectArtifacts.daysAgo}
                            </div>
                          </div>
                        </div>

                        <div className="text-xs font-ibm-mono text-[var(--text-primary)] shrink-0">
                          {formatBytes(art.size_bytes)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </WinUICard>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!scanning && (!scanResult || scanResult.projects.length === 0) && (
        <WinUICard className="p-8 text-center space-y-2">
          <Code20Regular className="w-10 h-10 text-[var(--text-secondary)] mx-auto opacity-40" />
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">{t.projectArtifacts.readyTitle}</h4>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.projectArtifacts.readyDesc}
          </p>
        </WinUICard>
      )}
    </div>
  );
};
