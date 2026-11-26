import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { toast } from "@/stores/toast-store";
import {
  Sparkle20Filled,
  Code20Regular,
  Box20Filled,
  ArrowClockwise20Regular,
  Delete20Regular,
  FolderOpen16Regular,
  CheckmarkCircle20Filled,
  Warning20Filled,
  DismissCircle20Regular,
} from "@fluentui/react-icons";

export interface AiModelInfo {
  id: string;
  name: string;
  provider: string;
  path: string;
  size_bytes: number;
  modified_at: number | null;
  description: string | null;
  is_directory: boolean;
}

export interface RustToolchainInfo {
  name: string;
  path: string;
  is_active: boolean;
  size_bytes: number;
  modified_at: number | null;
  channel: string;
}

export interface RustToolchainScanResult {
  toolchains: RustToolchainInfo[];
  total_size_bytes: number;
  active_toolchain: string | null;
  rustup_installed: boolean;
}

export interface CondaCacheInfo {
  found: boolean;
  conda_path: string | null;
  cache_dirs: string[];
  total_size_bytes: number;
  package_count: number;
}

export const AiAndToolchainsView: React.FC = () => {
  const { t } = useI18nStore();
  const [subTab, setSubTab] = useState<"ai" | "rust" | "conda">("ai");

  // AI Models state
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [loadingAi, setLoadingAi] = useState(false);
  const [deletingModelPath, setDeletingModelPath] = useState<string | null>(null);

  // Rust Toolchains state
  const [rustData, setRustData] = useState<RustToolchainScanResult | null>(null);
  const [loadingRust, setLoadingRust] = useState(false);
  const [deletingToolchainName, setDeletingToolchainName] = useState<string | null>(null);

  // Conda Cache state
  const [condaData, setCondaData] = useState<CondaCacheInfo | null>(null);
  const [loadingConda, setLoadingConda] = useState(false);
  const [cleaningConda, setCleaningConda] = useState(false);

  // Confirmation modal state
  const [confirmTarget, setConfirmTarget] = useState<{
    type: "ai" | "rust" | "conda";
    name: string;
    path: string;
    isActive?: boolean;
    sizeBytes: number;
  } | null>(null);

  const formatBytes = (bytes: number): string => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const scanAiModels = async () => {
    setLoadingAi(true);
    try {
      const res = await invoke<AiModelInfo[]>("scan_ai_models");
      setModels(res || []);
    } catch (e: any) {
      toast.error("AI Scan Failed", String(e));
    } finally {
      setLoadingAi(false);
    }
  };

  const scanRustToolchains = async () => {
    setLoadingRust(true);
    try {
      const res = await invoke<RustToolchainScanResult>("scan_rust_toolchains");
      setRustData(res);
    } catch (e: any) {
      toast.error("Rust Toolchains Scan Failed", String(e));
    } finally {
      setLoadingRust(false);
    }
  };

  const scanConda = async () => {
    setLoadingConda(true);
    try {
      const res = await invoke<CondaCacheInfo>("scan_conda_cache");
      setCondaData(res);
    } catch (e: any) {
      toast.error("Conda Scan Failed", String(e));
    } finally {
      setLoadingConda(false);
    }
  };

  useEffect(() => {
    scanAiModels();
    scanRustToolchains();
    scanConda();
  }, []);

  const handleCleanModel = async (path: string) => {
    setDeletingModelPath(path);
    try {
      const freed = await invoke<number>("clean_ai_model", { path });
      toast.success(
        t.aiAndToolchains.modelCleanedSuccess,
        `Reclaimed ${formatBytes(freed)}`
      );
      setModels((prev) => prev.filter((m) => m.path !== path));
    } catch (e: any) {
      toast.error("Delete Failed", String(e));
    } finally {
      setDeletingModelPath(null);
      setConfirmTarget(null);
    }
  };

  const handleCleanToolchain = async (name: string, force: boolean) => {
    setDeletingToolchainName(name);
    try {
      const freed = await invoke<number>("clean_rust_toolchain", {
        toolchain: name,
        force,
      });
      toast.success(
        t.aiAndToolchains.toolchainCleanedSuccess,
        `Reclaimed ${formatBytes(freed)}`
      );
      scanRustToolchains();
    } catch (e: any) {
      toast.error("Uninstall Failed", String(e));
    } finally {
      setDeletingToolchainName(null);
      setConfirmTarget(null);
    }
  };

  const handleCleanConda = async () => {
    setCleaningConda(true);
    try {
      const freed = await invoke<number>("clean_conda_cache");
      toast.success(
        t.aiAndToolchains.condaCleanedSuccess,
        `Reclaimed ${formatBytes(freed)}`
      );
      scanConda();
    } catch (e: any) {
      toast.error("Conda Clean Failed", String(e));
    } finally {
      setCleaningConda(false);
      setConfirmTarget(null);
    }
  };

  const totalAiBytes = models.reduce((acc, m) => acc + m.size_bytes, 0);
  const totalRustBytes = rustData?.total_size_bytes || 0;
  const totalCondaBytes = condaData?.total_size_bytes || 0;

  const getProviderBadge = (provider: string) => {
    switch (provider) {
      case "ollama":
        return { label: "Ollama", bg: "bg-purple-500/10 text-purple-400 border-purple-500/20" };
      case "lmstudio":
        return { label: "LM Studio", bg: "bg-blue-500/10 text-blue-400 border-blue-500/20" };
      case "huggingface":
        return { label: "Hugging Face", bg: "bg-amber-500/10 text-amber-400 border-amber-500/20" };
      case "gpt4all":
        return { label: "GPT4All", bg: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" };
      case "jan":
        return { label: "Jan AI", bg: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" };
      case "claudecode":
        return { label: "Claude Code", bg: "bg-rose-500/10 text-rose-400 border-rose-500/20" };
      case "gemini":
        return { label: "Gemini / Assistant", bg: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" };
      default:
        return { label: provider, bg: "bg-white/[0.04] text-[var(--text-secondary)] border-[var(--border-subtle)]" };
    }
  };

  return (
    <div className="space-y-4">
      {/* Sub-tab Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSubTab("ai")}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
              subTab === "ai"
                ? "bg-[#0078d4] text-white shadow-xs"
                : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
            }`}
          >
            <Sparkle20Filled className="w-3.5 h-3.5" />
            <span>
              {t.aiAndToolchains.tabAiModels} ({models.length})
            </span>
          </button>
          <button
            onClick={() => setSubTab("rust")}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
              subTab === "rust"
                ? "bg-[#0078d4] text-white shadow-xs"
                : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
            }`}
          >
            <Code20Regular className="w-3.5 h-3.5" />
            <span>
              {t.aiAndToolchains.tabRustToolchains} ({rustData?.toolchains.length || 0})
            </span>
          </button>
          <button
            onClick={() => setSubTab("conda")}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-[4px] transition-all cursor-pointer flex items-center gap-1.5 ${
              subTab === "conda"
                ? "bg-[#0078d4] text-white shadow-xs"
                : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white border border-[var(--border-subtle)]"
            }`}
          >
            <Box20Filled className="w-3.5 h-3.5" />
            <span>
              {t.aiAndToolchains.tabConda} ({condaData?.package_count || 0})
            </span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <WinUIButton
            variant="standard"
            onClick={() => {
              if (subTab === "ai") scanAiModels();
              else if (subTab === "rust") scanRustToolchains();
              else scanConda();
            }}
            disabled={loadingAi || loadingRust || loadingConda}
            icon={
              <ArrowClockwise20Regular
                className={`w-3.5 h-3.5 ${
                  loadingAi || loadingRust || loadingConda ? "animate-spin" : ""
                }`}
              />
            }
          >
            {t.aiAndToolchains.rescan}
          </WinUIButton>
        </div>
      </div>

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <WinUICard className="p-3.5 bg-[var(--card-bg)] border border-[var(--border-subtle)]">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              {t.aiAndToolchains.modelsFound}
            </span>
            <Sparkle20Filled className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-lg font-bold text-[var(--text-primary)] mt-1">
            {formatBytes(totalAiBytes)}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {models.length} {t.common.items}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5 bg-[var(--card-bg)] border border-[var(--border-subtle)]">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              {t.aiAndToolchains.toolchainsFound}
            </span>
            <Code20Regular className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-lg font-bold text-[var(--text-primary)] mt-1">
            {formatBytes(totalRustBytes)}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {rustData?.toolchains.length || 0} toolchain(s)
          </div>
        </WinUICard>

        <WinUICard className="p-3.5 bg-[var(--card-bg)] border border-[var(--border-subtle)]">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              {t.aiAndToolchains.condaPackagesFound}
            </span>
            <Box20Filled className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-lg font-bold text-[var(--text-primary)] mt-1">
            {formatBytes(totalCondaBytes)}
          </div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">
            {condaData?.package_count || 0} archives
          </div>
        </WinUICard>
      </div>

      {/* Subtab 1: AI Models & Sessions */}
      {subTab === "ai" && (
        <div className="space-y-3">
          {loadingAi ? (
            <WinUICard className="p-8 text-center space-y-3">
              <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                <span>{t.aiAndToolchains.scanning}</span>
              </div>
              <div className="max-w-xs mx-auto h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full animate-pulse w-3/4" />
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                Inspecting Ollama, HuggingFace, LM Studio, and GPT4All cache directories...
              </p>
            </WinUICard>
          ) : models.length === 0 ? (
            <WinUICard className="p-8 text-center text-[var(--text-secondary)]">
              <CheckmarkCircle20Filled className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {t.aiAndToolchains.noModelsFound}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                {t.aiAndToolchains.noModelsDesc}
              </div>
            </WinUICard>
          ) : (
            models.map((model) => {
              const badge = getProviderBadge(model.provider);
              const isDeleting = deletingModelPath === model.path;
              return (
                <WinUICard
                  key={model.id}
                  className="p-3.5 bg-[var(--card-bg)] border border-[var(--border-subtle)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-[var(--border-default)] transition-colors"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-xs text-[var(--text-primary)] truncate">
                        {model.name}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border font-medium ${badge.bg}`}
                      >
                        {badge.label}
                      </span>
                      {model.is_directory && (
                        <span className="text-xs px-1.5 py-0.2 bg-white/[0.04] text-[var(--text-muted)] rounded border border-[var(--border-subtle)]">
                          Directory
                        </span>
                      )}
                    </div>
                    {model.description && (
                      <p className="text-xs text-[var(--text-muted)] line-clamp-1">
                        {model.description}
                      </p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] truncate font-mono">
                      {model.path}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                    <div className="text-right">
                      <div className="text-xs font-bold text-[var(--text-primary)]">
                        {formatBytes(model.size_bytes)}
                      </div>
                    </div>

                    <button
                      onClick={() => revealItemInDir(model.path)}
                      title={t.common.showInFolder}
                      className="p-1.5 text-[var(--text-secondary)] hover:text-white rounded hover:bg-white/[0.06] cursor-pointer transition-colors"
                    >
                      <FolderOpen16Regular className="w-4 h-4" />
                    </button>

                    <WinUIButton
                      variant="danger"
                      size="sm"
                      disabled={isDeleting}
                      onClick={() =>
                        setConfirmTarget({
                          type: "ai",
                          name: model.name,
                          path: model.path,
                          sizeBytes: model.size_bytes,
                        })
                      }
                      icon={<Delete20Regular className="w-3.5 h-3.5" />}
                    >
                      {isDeleting ? t.aiAndToolchains.cleaningModel : t.aiAndToolchains.cleanModel}
                    </WinUIButton>
                  </div>
                </WinUICard>
              );
            })
          )}
        </div>
      )}

      {/* Subtab 2: Rust Toolchains */}
      {subTab === "rust" && (
        <div className="space-y-3">
          {loadingRust ? (
            <WinUICard className="p-8 text-center space-y-3">
              <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </span>
                <span>{t.aiAndToolchains.scanning}</span>
              </div>
              <div className="max-w-xs mx-auto h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full animate-pulse w-3/4" />
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                Inspecting Rustup installed toolchains and multi-gigabyte build targets...
              </p>
            </WinUICard>
          ) : !rustData || rustData.toolchains.length === 0 ? (
            <WinUICard className="p-8 text-center text-[var(--text-secondary)]">
              <CheckmarkCircle20Filled className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {t.aiAndToolchains.noToolchainsFound}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                {t.aiAndToolchains.noToolchainsDesc}
              </div>
            </WinUICard>
          ) : (
            rustData.toolchains.map((tc) => {
              const isDeleting = deletingToolchainName === tc.name;
              return (
                <WinUICard
                  key={tc.name}
                  className={`p-3.5 bg-[var(--card-bg)] border transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    tc.is_active
                      ? "border-emerald-500/30 bg-emerald-500/[0.02]"
                      : "border-[var(--border-subtle)] hover:border-[var(--border-default)]"
                  }`}
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-xs text-[var(--text-primary)] truncate">
                        {tc.name}
                      </span>
                      {tc.is_active && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-medium">
                          ✓ {t.aiAndToolchains.activeDefault}
                        </span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded-full bg-white/[0.04] text-[var(--text-secondary)] border border-[var(--border-subtle)] font-medium capitalize">
                        {tc.channel}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] truncate font-mono">
                      {tc.path}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                    <div className="text-right">
                      <div className="text-xs font-bold text-[var(--text-primary)]">
                        {formatBytes(tc.size_bytes)}
                      </div>
                    </div>

                    <button
                      onClick={() => revealItemInDir(tc.path)}
                      title={t.common.showInFolder}
                      className="p-1.5 text-[var(--text-secondary)] hover:text-white rounded hover:bg-white/[0.06] cursor-pointer transition-colors"
                    >
                      <FolderOpen16Regular className="w-4 h-4" />
                    </button>

                    <WinUIButton
                      variant={tc.is_active ? "standard" : "danger"}
                      size="sm"
                      disabled={isDeleting}
                      onClick={() =>
                        setConfirmTarget({
                          type: "rust",
                          name: tc.name,
                          path: tc.path,
                          isActive: tc.is_active,
                          sizeBytes: tc.size_bytes,
                        })
                      }
                      icon={<Delete20Regular className="w-3.5 h-3.5" />}
                    >
                      {isDeleting
                        ? t.aiAndToolchains.cleaningToolchain
                        : t.aiAndToolchains.cleanToolchain}
                    </WinUIButton>
                  </div>
                </WinUICard>
              );
            })
          )}
        </div>
      )}

      {/* Subtab 3: Conda Package Cache */}
      {subTab === "conda" && (
        <div className="space-y-3">
          {loadingConda ? (
            <WinUICard className="p-8 text-center space-y-3">
              <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                <span>{t.aiAndToolchains.scanning}</span>
              </div>
              <div className="max-w-xs mx-auto h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full animate-pulse w-3/4" />
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                Inspecting Conda and Miniconda package tarball caches...
              </p>
            </WinUICard>
          ) : !condaData || (!condaData.found && condaData.total_size_bytes === 0) ? (
            <WinUICard className="p-8 text-center text-[var(--text-secondary)]">
              <CheckmarkCircle20Filled className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <div className="text-sm font-semibold text-[var(--text-primary)]">
                {t.aiAndToolchains.noCondaFound}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">
                {t.aiAndToolchains.noCondaDesc}
              </div>
            </WinUICard>
          ) : (
            <WinUICard className="p-5 bg-[var(--card-bg)] border border-[var(--border-subtle)] space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-sm text-[var(--text-primary)] flex items-center gap-2">
                    <Box20Filled className="w-4 h-4 text-emerald-400" />
                    Conda & Miniconda Downloaded Package Tarballs
                  </h3>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {condaData.package_count} cached .conda and .tar.bz2 archives consuming{" "}
                    <strong>{formatBytes(condaData.total_size_bytes)}</strong>.
                  </p>
                </div>

                <WinUIButton
                  variant="primary"
                  disabled={cleaningConda || condaData.total_size_bytes === 0}
                  onClick={() =>
                    setConfirmTarget({
                      type: "conda",
                      name: "Conda Package Cache",
                      path: condaData.cache_dirs[0] || "",
                      sizeBytes: condaData.total_size_bytes,
                    })
                  }
                  icon={<Delete20Regular className="w-3.5 h-3.5" />}
                >
                  {cleaningConda
                    ? t.aiAndToolchains.cleaningConda
                    : `${t.aiAndToolchains.cleanConda} (${formatBytes(
                        condaData.total_size_bytes
                      )})`}
                </WinUIButton>
              </div>

              {condaData.cache_dirs.length > 0 && (
                <div className="bg-black/20 p-3 rounded border border-[var(--border-subtle)] space-y-1.5">
                  <div className="text-xs font-semibold text-[var(--text-secondary)]">
                    Scanned Package Repositories:
                  </div>
                  {condaData.cache_dirs.map((dir) => (
                    <div
                      key={dir}
                      className="text-xs text-[var(--text-muted)] font-mono flex items-center justify-between"
                    >
                      <span>{dir}</span>
                      <button
                        onClick={() => revealItemInDir(dir)}
                        className="text-[var(--text-secondary)] hover:text-white cursor-pointer"
                        title={t.common.showInFolder}
                      >
                        <FolderOpen16Regular className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </WinUICard>
          )}
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <WinUICard className="max-w-md w-full p-5 bg-[var(--card-bg)] border border-[var(--border-subtle)] shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 text-amber-400">
                <Warning20Filled className="w-5 h-5 shrink-0" />
                <h3 className="font-semibold text-sm text-[var(--text-primary)]">
                  {confirmTarget.type === "ai"
                    ? t.aiAndToolchains.confirmDeleteModel
                    : confirmTarget.type === "rust"
                    ? t.aiAndToolchains.confirmDeleteToolchain
                    : t.aiAndToolchains.confirmCleanConda}
                </h3>
              </div>
              <button
                onClick={() => setConfirmTarget(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <DismissCircle20Regular className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)]">
              {confirmTarget.type === "ai"
                ? t.aiAndToolchains.confirmDeleteModelDesc
                : confirmTarget.type === "rust"
                ? t.aiAndToolchains.confirmDeleteToolchainDesc
                : t.aiAndToolchains.confirmCleanCondaDesc}
            </p>

            {confirmTarget.isActive && (
              <div className="bg-rose-500/10 border border-rose-500/30 p-2.5 rounded text-xs text-rose-300 flex items-center gap-2">
                <Warning20Filled className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{t.aiAndToolchains.activeToolchainWarning}</span>
              </div>
            )}

            <div className="bg-white/[0.04] p-3 rounded border border-[var(--border-subtle)] space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">{t.common.name}:</span>
                <span className="font-medium text-[var(--text-primary)]">
                  {confirmTarget.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-muted)]">{t.common.size}:</span>
                <span className="font-semibold text-emerald-400">
                  {formatBytes(confirmTarget.sizeBytes)}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton
                variant="standard"
                onClick={() => setConfirmTarget(null)}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant={confirmTarget.isActive ? "danger" : "primary"}
                onClick={() => {
                  if (confirmTarget.type === "ai") {
                    handleCleanModel(confirmTarget.path);
                  } else if (confirmTarget.type === "rust") {
                    handleCleanToolchain(confirmTarget.name, !!confirmTarget.isActive);
                  } else {
                    handleCleanConda();
                  }
                }}
              >
                {t.common.confirm}
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};
