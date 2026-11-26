import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { toast } from "@/stores/toast-store";
import { SectionTitle, Card, StatCard, Badge, ProgressBar, EmptyState } from "@/components/ui";
import {
  Server20Regular,
  Box20Regular,
  Desktop20Regular,
  ArrowClockwise20Regular,
  ArrowMinimize20Regular,
  CheckmarkCircle20Filled,
  Warning20Regular,
  Info20Regular,
  FolderOpen16Regular,
  Delete20Regular,
  Sparkle20Regular,
} from "@fluentui/react-icons";

export interface WslDistribution {
  name: string;
  vhdx_path: string;
  vhdx_actual_bytes: number;
  vhdx_virtual_bytes: number;
  reclaimable_estimate: number;
  state: string;
  is_default: boolean;
  version: number;
}

export interface DockerSpaceCategory {
  category: string;
  total_count: number;
  active_count: number;
  size_bytes: number;
  reclaimable_bytes: number;
}

export interface DockerInfo {
  is_installed: boolean;
  is_running: boolean;
  server_version?: string | null;
  storage_driver?: string | null;
  data_root?: string | null;
  total_space_bytes: number;
  total_reclaimable_bytes: number;
  categories: DockerSpaceCategory[];
}

export interface HyperVDisk {
  vm_name: string;
  disk_path: string;
  size_bytes: number;
  format: string;
}

export interface VirtualizationOverview {
  wsl_installed: boolean;
  wsl_distributions: WslDistribution[];
  total_wsl_bytes: number;
  total_wsl_reclaimable: number;
  docker: DockerInfo;
  hyperv_disks: HyperVDisk[];
  total_vm_bytes: number;
}

export interface CompactionResult {
  target_name: string;
  path: string;
  before_bytes: number;
  after_bytes: number;
  freed_bytes: number;
  success: boolean;
  message: string;
}

export const VirtualizationView: React.FC<{
  /** Bumped by the parent page's Refresh button to reload the overview. */
  refreshToken?: number;
}> = ({ refreshToken = 0 }) => {
  const { t } = useI18nStore();
  const [overview, setOverview] = useState<VirtualizationOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [compactingDistro, setCompactingDistro] = useState<string | null>(null);
  const [pruningType, setPruningType] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const loadOverview = async () => {
    setLoading(true);
    try {
      const data = await invoke<VirtualizationOverview>("get_virtualization_overview");
      setOverview(data);
    } catch (err) {
      console.error("Failed to load virtualization overview:", err);
      toast.error(t.common.error, String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, [refreshToken]);

  const handleCompactWsl = async (distro: WslDistribution) => {
    setCompactingDistro(distro.name);
    try {
      const result = await invoke<CompactionResult>("compact_wsl_distribution", {
        distroName: distro.name,
      });

      if (result.success) {
        toast.success(
          t.virtualization.compactSuccess,
          `${distro.name}: ${formatBytes(result.freed_bytes)} ${t.virtualization.statTotalReclaimable.toLowerCase()} (${formatBytes(result.before_bytes)} → ${formatBytes(result.after_bytes)})`
        );
      } else {
        toast.error(t.virtualization.compactError, result.message);
      }
      await loadOverview();
    } catch (err) {
      toast.error(t.virtualization.compactError, String(err));
    } finally {
      setCompactingDistro(null);
    }
  };

  const handleDockerPrune = async (pruneType: string) => {
    setPruningType(pruneType);
    try {
      const freed = await invoke<number>("docker_prune", { pruneType });
      toast.success(
        t.virtualization.dockerPruneSuccess,
        `${formatBytes(freed)} ${t.virtualization.statTotalReclaimable.toLowerCase()}`
      );
      await loadOverview();
    } catch (err) {
      toast.error(t.common.error, String(err));
    } finally {
      setPruningType(null);
    }
  };

  const handleReveal = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.warn("Failed to reveal item in Explorer:", err);
    }
  };

  const totalReclaimable =
    (overview?.total_wsl_reclaimable || 0) +
    (overview?.docker?.total_reclaimable_bytes || 0);

  const operationLabel = compactingDistro
    ? `${t.virtualization.compacting} ${compactingDistro}`
    : pruningType
    ? t.virtualization.dockerPruning
    : loading
    ? t.common.scanning
    : null;

  const tileClass =
    "w-9 h-9 rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center shrink-0 text-[var(--text-secondary)] [&_svg]:w-5 [&_svg]:h-5";

  const revealButton = (path: string) => (
    <span title={t.virtualization.revealInExplorer} className="shrink-0">
      <WinUIButton
        variant="subtle"
        size="sm"
        className="w-7 !px-0"
        aria-label={t.virtualization.revealInExplorer}
        onClick={() => handleReveal(path)}
        icon={<FolderOpen16Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
      />
    </span>
  );

  return (
    <div className="space-y-5 select-none">
      {/* Stat row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.virtualization.statWsl}
          value={formatBytes(overview?.total_wsl_bytes || 0)}
          hint={`${overview?.wsl_distributions.length || 0} ${t.common.items}`}
          icon={<Server20Regular />}
        />
        <StatCard
          label={t.virtualization.statDocker}
          value={formatBytes(overview?.docker?.total_space_bytes || 0)}
          hint={
            !overview?.docker?.is_installed
              ? t.virtualization.dockerNotInstalled
              : !overview?.docker?.is_running
              ? t.virtualization.dockerNotRunning
              : `${overview.docker.categories.length} ${t.virtualization.dockerItems}`
          }
          icon={<Box20Regular />}
        />
        <StatCard
          label={t.virtualization.statVm}
          value={formatBytes(overview?.total_vm_bytes || 0)}
          hint={`${overview?.hyperv_disks.length || 0} ${t.common.files}`}
          icon={<Desktop20Regular />}
        />
        <StatCard
          label={t.virtualization.statTotalReclaimable}
          value={formatBytes(totalReclaimable)}
          hint={t.virtualization.reclaimable}
          icon={<Sparkle20Regular />}
          tone={totalReclaimable > 0 ? "success" : "neutral"}
        />
      </div>

      {/* Running operation */}
      {operationLabel && (
        <Card className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <ArrowClockwise20Regular className="w-4 h-4 animate-spin text-[var(--accent-text)]" />
            <span className="truncate">{operationLabel}</span>
          </div>
          <ProgressBar value={75} className="animate-pulse" />
          {(compactingDistro || pruningType) && (
            <p className="text-xs text-[var(--text-muted)]">{t.virtualization.operationInProgress}</p>
          )}
        </Card>
      )}

      {/* Safety notice */}
      <Card className="py-3 flex items-start gap-3">
        <Info20Regular className="w-4 h-4 shrink-0 mt-0.5 text-[var(--accent-text)]" />
        <div className="space-y-0.5 min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">{t.virtualization.wslNotice}</div>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{t.virtualization.wslDesc}</p>
        </div>
      </Card>

      {/* 1. WSL2 */}
      <SectionTitle>{t.virtualization.wslTitle}</SectionTitle>
      {overview?.wsl_distributions && overview.wsl_distributions.length > 0 ? (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {overview.wsl_distributions.map((distro) => {
              const isCompacting = compactingDistro === distro.name;
              const hasReclaimable = distro.reclaimable_estimate > 0;
              const percentUsed =
                distro.vhdx_virtual_bytes > 0
                  ? Math.min(100, Math.round((distro.vhdx_actual_bytes / distro.vhdx_virtual_bytes) * 100))
                  : 100;
              const running = distro.state.toLowerCase() === "running";

              return (
                <div
                  key={distro.name}
                  className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={tileClass}>
                      <Server20Regular />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{distro.name}</span>
                        {distro.is_default && <Badge tone="accent">{t.virtualization.defaultBadge}</Badge>}
                        <Badge tone={running ? "success" : "neutral"}>
                          {running ? t.virtualization.stateRunning : t.virtualization.stateStopped}
                        </Badge>
                        <span className="font-code text-xs text-[var(--text-muted)]">WSL v{distro.version}</span>
                      </div>

                      <div className="flex items-center gap-1 min-w-0">
                        <span className="font-code text-xs text-[var(--text-muted)] truncate select-text" title={distro.vhdx_path}>
                          {distro.vhdx_path}
                        </span>
                        {revealButton(distro.vhdx_path)}
                      </div>

                      <div className="space-y-1 max-w-lg">
                        <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
                          <span>
                            {t.virtualization.totalSize}:{" "}
                            <span className="text-[var(--text-primary)] font-ibm-mono">
                              {formatBytes(distro.vhdx_actual_bytes)}
                            </span>
                          </span>
                          {distro.vhdx_virtual_bytes > 0 && (
                            <span>
                              {t.virtualization.virtualSize}:{" "}
                              <span className="text-[var(--text-primary)] font-ibm-mono">
                                {formatBytes(distro.vhdx_virtual_bytes)}
                              </span>
                            </span>
                          )}
                        </div>
                        <ProgressBar value={percentUsed} />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0 self-end md:self-center">
                    <div className="text-right">
                      <div className="text-xs text-[var(--text-muted)]">{t.virtualization.reclaimable}</div>
                      <div
                        className={`text-sm font-semibold font-ibm-mono ${
                          hasReclaimable ? "text-[var(--success)]" : "text-[var(--text-muted)]"
                        }`}
                      >
                        {formatBytes(distro.reclaimable_estimate)}
                      </div>
                    </div>
                    <WinUIButton
                      variant="standard"
                      onClick={() => handleCompactWsl(distro)}
                      disabled={isCompacting || Boolean(compactingDistro)}
                      icon={
                        isCompacting ? (
                          <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                        ) : (
                          <ArrowMinimize20Regular className="w-4 h-4" />
                        )
                      }
                    >
                      {isCompacting ? t.virtualization.compacting : t.virtualization.compactVhdx}
                    </WinUIButton>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={<Server20Regular />}
          title={t.virtualization.noDistros}
          description={t.virtualization.noDistrosDesc}
        />
      )}

      {/* 2. Docker */}
      <SectionTitle
        action={
          overview?.docker?.is_running ? (
            <WinUIButton
              variant="danger"
              size="sm"
              onClick={() => handleDockerPrune("all")}
              disabled={Boolean(pruningType)}
              icon={
                pruningType === "all" ? (
                  <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Delete20Regular className="w-3.5 h-3.5" />
                )
              }
            >
              {pruningType === "all" ? t.virtualization.dockerPruning : t.virtualization.dockerPruneAll}
            </WinUIButton>
          ) : undefined
        }
      >
        {t.virtualization.dockerTitle}
      </SectionTitle>

      {!overview?.docker?.is_installed ? (
        <EmptyState
          icon={<Box20Regular />}
          title={t.virtualization.dockerNotInstalled}
          description={t.virtualization.dockerNotInstalledDesc}
        />
      ) : !overview?.docker?.is_running ? (
        <EmptyState
          icon={<Warning20Regular className="text-[var(--brand-amber)]" />}
          title={t.virtualization.dockerNotRunning}
          description={t.virtualization.dockerNotRunningDesc}
        />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {/* Engine details */}
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <CheckmarkCircle20Filled className="w-4 h-4 text-[var(--success)]" />
                  <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t.virtualization.dockerEngine} v{overview.docker.server_version || "WSL2"}
                  </span>
                </span>
                {overview.docker.storage_driver && (
                  <span className="text-[var(--text-muted)]">
                    {t.virtualization.dockerDriver}:{" "}
                    <span className="font-code">{overview.docker.storage_driver}</span>
                  </span>
                )}
              </div>
              <div className="text-[var(--text-muted)]">
                {t.virtualization.statTotalReclaimable}:{" "}
                <span className="font-ibm-mono font-semibold text-[var(--success)]">
                  {formatBytes(overview.docker.total_reclaimable_bytes)}
                </span>
              </div>
            </div>

            {/* Categories */}
            {overview.docker.categories.map((cat) => {
              const targetKey = cat.category.toLowerCase().includes("build")
                ? "build_cache"
                : cat.category.toLowerCase().includes("image")
                ? "images"
                : cat.category.toLowerCase().includes("volume")
                ? "volumes"
                : "containers";

              const isPruningThis = pruningType === targetKey;

              return (
                <div
                  key={cat.category}
                  className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className={tileClass}>
                      <Box20Regular />
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{cat.category}</span>
                        <Badge>
                          {cat.total_count} {t.virtualization.dockerItems} ({cat.active_count} {t.virtualization.dockerActive})
                        </Badge>
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {t.virtualization.totalSize}:{" "}
                        <span className="font-ibm-mono">{formatBytes(cat.size_bytes)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 shrink-0 self-end sm:self-center">
                    <div className="text-right">
                      <div className="text-xs text-[var(--text-muted)]">{t.virtualization.reclaimable}</div>
                      <div
                        className={`text-sm font-semibold font-ibm-mono ${
                          cat.reclaimable_bytes > 0 ? "text-[var(--success)]" : "text-[var(--text-muted)]"
                        }`}
                      >
                        {formatBytes(cat.reclaimable_bytes)}
                      </div>
                    </div>
                    <WinUIButton
                      variant="standard"
                      size="sm"
                      onClick={() => handleDockerPrune(targetKey)}
                      disabled={Boolean(pruningType) || cat.reclaimable_bytes === 0}
                      icon={
                        isPruningThis ? (
                          <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Delete20Regular className="w-3.5 h-3.5" />
                        )
                      }
                    >
                      {isPruningThis ? t.virtualization.dockerPruning : t.common.clean}
                    </WinUIButton>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* 3. Hyper-V and VM images */}
      <SectionTitle
        action={
          <span className="text-xs text-[var(--text-muted)]">
            {overview?.hyperv_disks.length || 0} {t.common.files}
          </span>
        }
      >
        {t.virtualization.vmTitle}
      </SectionTitle>

      {overview?.hyperv_disks && overview.hyperv_disks.length > 0 ? (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {overview.hyperv_disks.map((disk) => (
              <div
                key={disk.disk_path}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
              >
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div className={tileClass}>
                    <Desktop20Regular />
                  </div>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{disk.vm_name}</span>
                      <Badge className="font-code">{disk.format}</Badge>
                    </div>
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="font-code text-xs text-[var(--text-muted)] truncate select-text" title={disk.disk_path}>
                        {disk.disk_path}
                      </span>
                      {revealButton(disk.disk_path)}
                    </div>
                  </div>
                </div>

                <div className="text-right shrink-0 self-end sm:self-center">
                  <div className="text-xs text-[var(--text-muted)]">{t.virtualization.totalSize}</div>
                  <div className="text-sm font-semibold font-ibm-mono text-[var(--text-primary)]">
                    {formatBytes(disk.size_bytes)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={<Desktop20Regular />}
          title={t.virtualization.vmNoDisks}
          description={t.virtualization.vmNoDisksDesc}
        />
      )}
    </div>
  );
};
