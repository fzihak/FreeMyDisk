import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { Card, StatCard, Badge, FilterTabs, EmptyState, ActionBar } from "@/components/ui";

/** Fills `{name}` placeholders in a translated string. */
const fill = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

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
    <div className="space-y-5">
      {/* Controls */}
      <Card className="space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center shrink-0">
              <Code20Regular className="w-5 h-5 text-[var(--accent-text)]" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.projectArtifacts.title}</h3>
              <p className="text-xs text-[var(--text-secondary)]">{t.projectArtifacts.subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label className="h-8 flex items-center gap-2 px-2.5 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-secondary)]">
              <span>{t.projectArtifacts.threshold}</span>
              <select
                value={minSizeMb}
                onChange={(e) => setMinSizeMb(Number(e.target.value))}
                className="bg-transparent text-[var(--text-primary)] font-ibm-mono text-sm focus:outline-none cursor-pointer"
              >
                <option value={1} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 1 MB</option>
                <option value={5} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 5 MB</option>
                <option value={20} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 20 MB</option>
                <option value={100} className="bg-[var(--bg-card)] text-[var(--text-primary)]">≥ 100 MB</option>
              </select>
            </label>

            <WinUIButton
              variant={selectedArtifacts.length > 0 ? "standard" : "primary"}
              onClick={handleScan}
              disabled={scanning || cleaning}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />}
            >
              {scanning ? t.projectArtifacts.scanning : t.projectArtifacts.scanButton}
            </WinUIButton>
          </div>
        </div>

        {/* Quick selection and type filter (when results exist) */}
        {scanResult && scanResult.projects.length > 0 && (
          <div className="pt-3 border-t border-[var(--border-divider)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <WinUIButton
                variant="subtle"
                size="sm"
                onClick={() => selectStaleOnly(30)}
                icon={<Clock20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
              >
                {t.projectArtifacts.selectDormant}
              </WinUIButton>
              <WinUIButton variant="subtle" size="sm" onClick={selectAllSafe}>
                {t.projectArtifacts.selectAll}
              </WinUIButton>
              <WinUIButton variant="subtle" size="sm" onClick={deselectAll}>
                {t.projectArtifacts.clearSelection}
              </WinUIButton>
            </div>

            {projectTypes.length > 1 && (
              <FilterTabs
                items={[
                  { id: "all", label: t.projectArtifacts.filterAll, count: scanResult.projects.length },
                  ...projectTypes.map((tItem) => ({
                    id: tItem,
                    label: tItem.replace("project_", "").toUpperCase(),
                  })),
                ]}
                value={filterType}
                onChange={setFilterType}
                className="min-w-0"
              />
            )}
          </div>
        )}
      </Card>

      {/* Result of the last cleanup */}
      {disposalSummary && (
        <Card className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <CheckmarkCircle20Filled className="w-5 h-5 text-[var(--success)] shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">{t.projectArtifacts.cleanupCompleteTitle}</div>
              <div className="text-xs text-[var(--text-secondary)] font-ibm-mono tabular-nums">
                {disposalSummary.successful_items} {t.common.items} · {describeDisposal(disposalSummary, t, formatBytes)}
              </div>
            </div>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setDisposalSummary(null)}>
            {t.common.dismiss}
          </WinUIButton>
        </Card>
      )}

      {/* Stats */}
      {scanResult && (
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label={t.projectArtifacts.discoveredProjects}
            value={scanResult.total_projects}
            icon={<Folder20Regular />}
          />
          <StatCard
            label={t.projectArtifacts.reclaimableArtifacts}
            value={scanResult.total_artifacts}
            icon={<Wrench20Regular />}
          />
          <StatCard
            label={t.projectArtifacts.totalReclaimableSpace}
            value={formatBytes(scanResult.total_reclaimable_bytes)}
            tone={scanResult.total_reclaimable_bytes > 0 ? "accent" : "neutral"}
            icon={<Delete20Regular />}
          />
        </div>
      )}

      {/* Progress */}
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

      {/* Project list */}
      {!scanning && scanResult && filteredProjects.length > 0 && (
        <Card padded={false} className="overflow-hidden divide-y divide-[var(--border-divider)]">
          {filteredProjects.map((project) => {
            const isExpanded = expandedProjects.has(project.project_root);
            const typeLabel = project.project_type.replace("project_", "").toUpperCase();

            return (
              <div key={project.project_root}>
                <div
                  onClick={() => toggleExpand(project.project_root)}
                  className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-[var(--text-secondary)] shrink-0">
                      {isExpanded ? <ChevronDown16Regular className="w-4 h-4" /> : <ChevronRight16Regular className="w-4 h-4" />}
                    </span>
                    <Folder20Regular className="w-5 h-5 text-[var(--text-secondary)] shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-[var(--text-primary)] truncate">{project.project_name}</span>
                        <Badge>{typeLabel}</Badge>
                        {project.last_modified_days_ago > 30 && (
                          <Badge tone="warning">
                            <Clock20Regular className="w-3.5 h-3.5" />
                            {project.last_modified_days_ago} {t.projectArtifacts.daysAgo} ({t.projectArtifacts.dormantBadge})
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-[var(--text-muted)] font-code truncate mt-0.5">{project.project_root}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-ibm-mono font-semibold text-[var(--text-primary)] tabular-nums">
                      {formatBytes(project.total_reclaimable_bytes)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReveal(project.project_root);
                      }}
                      className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle-hover)] transition-colors cursor-pointer"
                      title={t.projectArtifacts.revealInExplorer}
                    >
                      <FolderOpen16Regular className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-[var(--border-divider)] bg-[var(--fill-subtle)] divide-y divide-[var(--border-divider)]">
                    {project.artifacts.map((art) => (
                      <div
                        key={art.path}
                        onClick={() => toggleArtifactSelected(project.project_root, art.path)}
                        className="pl-11 pr-4 py-2 flex items-center justify-between gap-3 hover:bg-[var(--fill-subtle-hover)] cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <input
                            type="checkbox"
                            checked={art.selected}
                            onChange={() => {}}
                            className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                          />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-code text-xs font-semibold text-[var(--text-primary)]">{art.relative_path}</span>
                              <Badge className="capitalize">{art.category}</Badge>
                              {art.rebuild_command && (
                                <span title={t.projectArtifacts.rebuildCommand}>
                                  <Badge className="font-code">
                                    <Wrench20Regular className="w-3.5 h-3.5" />
                                    {art.rebuild_command}
                                  </Badge>
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">
                              {art.item_count} {t.common.files} · {art.staleness_days} {t.projectArtifacts.daysAgo}
                            </div>
                          </div>
                        </div>

                        <div className="text-sm font-ibm-mono text-[var(--text-primary)] tabular-nums shrink-0">
                          {formatBytes(art.size_bytes)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* Empty state */}
      {!scanning && (!scanResult || scanResult.projects.length === 0) && (
        <EmptyState icon={<Code20Regular />} title={t.projectArtifacts.readyTitle} description={t.projectArtifacts.readyDesc} />
      )}

      {/* Selection action bar */}
      {selectedArtifacts.length > 0 && (
        <ActionBar
          summary={
            <span className="text-[var(--text-primary)] font-medium">
              {fill(t.cleanup.selectedSummary, {
                count: selectedArtifacts.length,
                size: formatBytes(totalSelectedBytes),
              })}
            </span>
          }
        >
          <WinUIButton variant="subtle" onClick={deselectAll}>
            {t.projectArtifacts.clearSelection}
          </WinUIButton>
          <WinUIButton
            variant="primary"
            onClick={handleCleanSelected}
            disabled={cleaning || scanning}
            icon={<Delete20Regular className="w-4 h-4" />}
          >
            {cleaning
              ? t.common.deleting
              : `${t.projectArtifacts.cleanSelected} (${selectedArtifacts.length}) · ${formatBytes(totalSelectedBytes)}`}
          </WinUIButton>
        </ActionBar>
      )}
    </div>
  );
};
