import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { toast } from "@/stores/toast-store";
import {
  Server20Filled,
  Box20Filled,
  Desktop20Filled,
  ArrowClockwise20Regular,
  CheckmarkCircle20Filled,
  ShieldError20Filled,
  Info20Regular,
  FolderOpen16Regular,
  Delete20Regular,
  Flash20Filled,
  Sparkle20Filled,
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

export const VirtualizationView: React.FC = () => {
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
  }, []);

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

  return (
    <div className="space-y-6 select-none font-sans text-[var(--text-primary)]">
      {/* 4-Stat Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-ibm-mono">
        {/* WSL2 Card */}
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.virtualization.statWsl}</span>
            <Server20Filled className="w-4 h-4 text-blue-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-blue-400 tabular-nums">
              {formatBytes(overview?.total_wsl_bytes || 0)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {overview?.wsl_distributions.length || 0} {t.common.items}
            </div>
          </div>
        </WinUICard>

        {/* Docker Card */}
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.virtualization.statDocker}</span>
            <Box20Filled className="w-4 h-4 text-cyan-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-cyan-400 tabular-nums">
              {formatBytes(overview?.docker?.total_space_bytes || 0)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {!overview?.docker?.is_installed
                ? t.virtualization.dockerNotInstalled
                : !overview?.docker?.is_running
                ? t.virtualization.dockerNotRunning
                : `${overview.docker.categories.length} ${t.virtualization.dockerItems}`}
            </div>
          </div>
        </WinUICard>

        {/* VM Card */}
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.virtualization.statVm}</span>
            <Desktop20Filled className="w-4 h-4 text-purple-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-purple-400 tabular-nums">
              {formatBytes(overview?.total_vm_bytes || 0)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {overview?.hyperv_disks.length || 0} {t.common.files}
            </div>
          </div>
        </WinUICard>

        {/* Total Reclaimable Card */}
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.virtualization.statTotalReclaimable}</span>
            <Sparkle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald-400 tabular-nums">
              {formatBytes(totalReclaimable)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {t.virtualization.reclaimable}
            </div>
          </div>
        </WinUICard>
      </div>

      {/* Safety Notice Callout */}
      <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 flex items-start gap-3">
        <Info20Regular className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <span className="font-semibold">{t.virtualization.wslNotice}</span>
          <p className="text-blue-300/80 leading-relaxed">
            {t.virtualization.wslDesc}
          </p>
        </div>
      </div>

      {/* 1. WSL2 Section */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Server20Filled className="w-4 h-4 text-blue-400" />
            <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {t.virtualization.wslTitle}
            </h2>
          </div>
          <WinUIButton
            variant="subtle"
            size="sm"
            onClick={loadOverview}
            disabled={loading}
            icon={<ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />}
          >
            {t.common.refresh}
          </WinUIButton>
        </div>

        {overview?.wsl_distributions && overview.wsl_distributions.length > 0 ? (
          <WinUICard className="divide-y divide-[var(--border-divider)]">
            {overview.wsl_distributions.map((distro) => {
              const isCompacting = compactingDistro === distro.name;
              const hasReclaimable = distro.reclaimable_estimate > 0;
              const percentUsed = distro.vhdx_virtual_bytes > 0
                ? Math.min(100, Math.round((distro.vhdx_actual_bytes / distro.vhdx_virtual_bytes) * 100))
                : 100;

              return (
                <div
                  key={distro.name}
                  className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors"
                >
                  <div className="flex items-start gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
                      <Server20Filled className="w-5 h-5" />
                    </div>
                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                          {distro.name}
                        </h3>
                        {distro.is_default && (
                          <span className="text-[10px] font-ibm-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
                            {t.virtualization.defaultBadge}
                          </span>
                        )}
                        <span
                          className={`text-[10px] font-ibm-mono px-2 py-0.5 rounded border font-medium ${
                            distro.state.toLowerCase() === "running"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                          }`}
                        >
                          {distro.state.toLowerCase() === "running"
                            ? t.virtualization.stateRunning
                            : t.virtualization.stateStopped}
                        </span>
                        <span className="text-[10px] font-ibm-mono text-[var(--text-muted)]">
                          WSL v{distro.version}
                        </span>
                      </div>

                      {/* Path and reveal */}
                      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] font-ibm-mono truncate">
                        <span className="truncate max-w-md">{distro.vhdx_path}</span>
                        <button
                          onClick={() => handleReveal(distro.vhdx_path)}
                          title={t.virtualization.revealInExplorer}
                          className="hover:text-[var(--text-primary)] text-[var(--text-secondary)] transition-colors p-0.5"
                        >
                          <FolderOpen16Regular className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Visual Size Bar */}
                      <div className="space-y-1 pt-1 max-w-lg">
                        <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                          <span>
                            {t.virtualization.totalSize}:{" "}
                            <strong className="text-[var(--text-primary)] font-ibm-mono">
                              {formatBytes(distro.vhdx_actual_bytes)}
                            </strong>
                          </span>
                          {distro.vhdx_virtual_bytes > 0 && (
                            <span>
                              {t.virtualization.virtualSize}:{" "}
                              <strong className="text-[var(--text-primary)] font-ibm-mono">
                                {formatBytes(distro.vhdx_virtual_bytes)}
                              </strong>
                            </span>
                          )}
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-300"
                            style={{ width: `${percentUsed}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Actions & Metrics */}
                  <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
                    <div className="text-right font-ibm-mono">
                      <div className="text-xs text-[var(--text-muted)] font-sans">
                        {t.virtualization.reclaimable}
                      </div>
                      <div
                        className={`text-sm font-bold tabular-nums ${
                          hasReclaimable ? "text-emerald-400" : "text-[var(--text-muted)]"
                        }`}
                      >
                        {formatBytes(distro.reclaimable_estimate)}
                      </div>
                    </div>

                    <div className="pl-2 border-l border-[var(--border-divider)]">
                      <WinUIButton
                        variant="primary"
                        onClick={() => handleCompactWsl(distro)}
                        disabled={isCompacting || Boolean(compactingDistro)}
                        icon={
                          isCompacting ? (
                            <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                          ) : (
                            <Flash20Filled className="w-4 h-4" />
                          )
                        }
                      >
                        {isCompacting ? t.virtualization.compacting : t.virtualization.compactVhdx}
                      </WinUIButton>
                    </div>
                  </div>
                </div>
              );
            })}
          </WinUICard>
        ) : (
          <WinUICard className="p-8 text-center space-y-2 text-[var(--text-muted)]">
            <Server20Filled className="w-8 h-8 mx-auto text-[var(--text-secondary)] opacity-60" />
            <div className="text-sm font-medium text-[var(--text-primary)]">
              {t.virtualization.noDistros}
            </div>
            <p className="text-xs max-w-md mx-auto">{t.virtualization.noDistrosDesc}</p>
          </WinUICard>
        )}
      </div>

      {/* 2. Docker Storage Section */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Box20Filled className="w-4 h-4 text-cyan-400" />
            <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {t.virtualization.dockerTitle}
            </h2>
          </div>
          {overview?.docker?.is_running && (
            <div className="flex items-center gap-2">
              <WinUIButton
                variant="danger"
                size="sm"
                onClick={() => handleDockerPrune("all")}
                disabled={Boolean(pruningType)}
                icon={<Delete20Regular className="w-3.5 h-3.5" />}
              >
                {pruningType === "all" ? t.virtualization.dockerPruning : t.virtualization.dockerPruneAll}
              </WinUIButton>
            </div>
          )}
        </div>

        {!overview?.docker?.is_installed ? (
          <WinUICard className="p-8 text-center space-y-2 text-[var(--text-muted)]">
            <Box20Filled className="w-8 h-8 mx-auto text-[var(--text-secondary)] opacity-40" />
            <div className="text-sm font-medium text-[var(--text-primary)]">
              {t.virtualization.dockerNotInstalled}
            </div>
            <p className="text-xs max-w-md mx-auto">
              {t.virtualization.dockerNotInstalledDesc}
            </p>
          </WinUICard>
        ) : !overview?.docker?.is_running ? (
          <WinUICard className="p-8 text-center space-y-2 text-[var(--text-muted)]">
            <ShieldError20Filled className="w-8 h-8 mx-auto text-amber-400 opacity-80" />
            <div className="text-sm font-medium text-[var(--text-primary)]">
              {t.virtualization.dockerNotRunning}
            </div>
            <p className="text-xs max-w-md mx-auto">
              {t.virtualization.dockerNotRunningDesc}
            </p>
          </WinUICard>
        ) : (
          <WinUICard className="divide-y divide-[var(--border-divider)]">
            {/* Docker Daemon Details Strip */}
            <div className="p-4 px-6 bg-white/[0.02] flex items-center justify-between text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400" />
                  <span className="font-medium text-[var(--text-primary)]">
                    Docker Engine v{overview.docker.server_version || "WSL2"}
                  </span>
                </span>
                {overview.docker.storage_driver && (
                  <span className="font-ibm-mono text-[11px] text-[var(--text-muted)]">
                    Driver: {overview.docker.storage_driver}
                  </span>
                )}
              </div>
              <div className="font-ibm-mono text-[11px] text-[var(--text-muted)]">
                {t.virtualization.statTotalReclaimable}:{" "}
                <span className="text-emerald-400 font-bold">
                  {formatBytes(overview.docker.total_reclaimable_bytes)}
                </span>
              </div>
            </div>

            {/* Docker Categories */}
            {overview.docker.categories.map((cat) => {
              const targetKey =
                cat.category.toLowerCase().includes("build")
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
                  className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-white/[0.015] transition-colors"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-[var(--text-primary)]">
                        {cat.category}
                      </span>
                      <span className="text-[11px] font-ibm-mono px-2 py-0.5 rounded bg-white/[0.06] text-[var(--text-secondary)]">
                        {cat.total_count} {t.virtualization.dockerItems} ({cat.active_count} {t.virtualization.dockerActive})
                      </span>
                    </div>
                    <div className="text-xs text-[var(--text-muted)] font-ibm-mono">
                      {t.virtualization.totalSize}: {formatBytes(cat.size_bytes)}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right font-ibm-mono">
                      <div className="text-xs text-[var(--text-muted)] font-sans">
                        {t.virtualization.reclaimable}
                      </div>
                      <div
                        className={`text-sm font-bold tabular-nums ${
                          cat.reclaimable_bytes > 0 ? "text-emerald-400" : "text-[var(--text-muted)]"
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
          </WinUICard>
        )}
      </div>

      {/* 3. Hyper-V & VM Images Section */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Desktop20Filled className="w-4 h-4 text-purple-400" />
            <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {t.virtualization.vmTitle}
            </h2>
          </div>
          <span className="text-[11px] text-[var(--text-muted)] font-ibm-mono">
            {overview?.hyperv_disks.length || 0} {t.common.files}
          </span>
        </div>

        {overview?.hyperv_disks && overview.hyperv_disks.length > 0 ? (
          <WinUICard className="divide-y divide-[var(--border-divider)]">
            {overview.hyperv_disks.map((disk) => (
              <div
                key={disk.disk_path}
                className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-white/[0.015] transition-colors"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold text-sm text-[var(--text-primary)]">
                      {disk.vm_name}
                    </span>
                    <span className="text-[10px] font-ibm-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 font-medium">
                      {disk.format}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] font-ibm-mono truncate">
                    <span className="truncate max-w-xl">{disk.disk_path}</span>
                    <button
                      onClick={() => handleReveal(disk.disk_path)}
                      title={t.virtualization.revealInExplorer}
                      className="hover:text-[var(--text-primary)] text-[var(--text-secondary)] transition-colors p-0.5"
                    >
                      <FolderOpen16Regular className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="text-right font-ibm-mono shrink-0">
                  <div className="text-xs text-[var(--text-muted)] font-sans">
                    {t.virtualization.totalSize}
                  </div>
                  <div className="text-sm font-bold text-purple-400 tabular-nums">
                    {formatBytes(disk.size_bytes)}
                  </div>
                </div>
              </div>
            ))}
          </WinUICard>
        ) : (
          <WinUICard className="p-8 text-center space-y-2 text-[var(--text-muted)]">
            <Desktop20Filled className="w-8 h-8 mx-auto text-[var(--text-secondary)] opacity-40" />
            <div className="text-sm font-medium text-[var(--text-primary)]">
              {t.virtualization.vmNoDisks}
            </div>
            <p className="text-xs max-w-md mx-auto">{t.virtualization.vmNoDisksDesc}</p>
          </WinUICard>
        )}
      </div>
    </div>
  );
};
