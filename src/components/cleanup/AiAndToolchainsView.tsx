import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { toast } from "@/stores/toast-store";
import {
  Sparkle20Regular,
  Code20Regular,
  Box20Regular,
  ArrowClockwise20Regular,
  Delete20Regular,
  FolderOpen16Regular,
  CheckmarkCircle20Filled,
  CheckmarkCircle16Filled,
  Warning20Filled,
  Dismiss16Regular,
} from "@fluentui/react-icons";
import { Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState } from "@/components/ui";

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

  const getProviderLabel = (provider: string) => {
    switch (provider) {
      case "ollama":
        return "Ollama";
      case "lmstudio":
        return "LM Studio";
      case "huggingface":
        return "Hugging Face";
      case "gpt4all":
        return "GPT4All";
      case "jan":
        return "Jan AI";
      case "claudecode":
        return "Claude Code";
      case "gemini":
        return "Gemini / Assistant";
      default:
        return provider;
    }
  };

  const renderLoading = (hint: string) => (
    <Card className="py-10 flex flex-col items-center text-center gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
        <ArrowClockwise20Regular className="w-4 h-4 animate-spin text-[var(--accent-text)]" />
        <span>{t.aiAndToolchains.scanning}</span>
      </div>
      <ProgressBar value={75} className="max-w-xs animate-pulse" />
      <p className="text-xs text-[var(--text-muted)]">{hint}</p>
    </Card>
  );

  const renderReveal = (path: string) => (
    <button
      onClick={() => revealItemInDir(path)}
      title={t.common.showInFolder}
      className="p-1.5 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle-hover)] cursor-pointer transition-colors"
    >
      <FolderOpen16Regular className="w-4 h-4" />
    </button>
  );

  return (
    <div className="space-y-5">
      {/* Sub-tab navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterTabs
          items={[
            {
              id: "ai",
              label: (
                <>
                  <Sparkle20Regular className="w-4 h-4" />
                  {t.aiAndToolchains.tabAiModels}
                </>
              ),
              count: models.length,
            },
            {
              id: "rust",
              label: (
                <>
                  <Code20Regular className="w-4 h-4" />
                  {t.aiAndToolchains.tabRustToolchains}
                </>
              ),
              count: rustData?.toolchains.length || 0,
            },
            {
              id: "conda",
              label: (
                <>
                  <Box20Regular className="w-4 h-4" />
                  {t.aiAndToolchains.tabConda}
                </>
              ),
              count: condaData?.package_count || 0,
            },
          ]}
          value={subTab}
          onChange={setSubTab}
          className="min-w-0"
        />

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
              className={`w-4 h-4 ${loadingAi || loadingRust || loadingConda ? "animate-spin" : ""}`}
            />
          }
        >
          {t.aiAndToolchains.rescan}
        </WinUIButton>
      </div>

      {/* Overview stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t.aiAndToolchains.modelsFound}
          value={formatBytes(totalAiBytes)}
          hint={`${models.length} ${t.common.items}`}
          icon={<Sparkle20Regular />}
        />
        <StatCard
          label={t.aiAndToolchains.toolchainsFound}
          value={formatBytes(totalRustBytes)}
          hint={`${rustData?.toolchains.length || 0} toolchain(s)`}
          icon={<Code20Regular />}
        />
        <StatCard
          label={t.aiAndToolchains.condaPackagesFound}
          value={formatBytes(totalCondaBytes)}
          hint={`${condaData?.package_count || 0} archives`}
          icon={<Box20Regular />}
        />
      </div>

      {/* Subtab 1: AI Models & Sessions */}
      {subTab === "ai" &&
        (loadingAi ? (
          renderLoading("Inspecting Ollama, HuggingFace, LM Studio, and GPT4All cache directories...")
        ) : models.length === 0 ? (
          <EmptyState
            icon={<CheckmarkCircle20Filled className="text-[var(--success)]" />}
            title={t.aiAndToolchains.noModelsFound}
            description={t.aiAndToolchains.noModelsDesc}
          />
        ) : (
          <Card padded={false} className="overflow-hidden divide-y divide-[var(--border-divider)]">
            {models.map((model) => {
              const isDeleting = deletingModelPath === model.path;
              return (
                <div
                  key={model.id}
                  className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">{model.name}</span>
                      <Badge tone="accent">{getProviderLabel(model.provider)}</Badge>
                      {model.is_directory && <Badge>{t.cleanup.stateDirectory}</Badge>}
                    </div>
                    {model.description && (
                      <p className="text-xs text-[var(--text-secondary)] line-clamp-1">{model.description}</p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] truncate font-code">{model.path}</p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <span className="text-sm font-semibold font-ibm-mono tabular-nums text-[var(--text-primary)] mr-1">
                      {formatBytes(model.size_bytes)}
                    </span>
                    {renderReveal(model.path)}
                    <WinUIButton
                      variant="standard"
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
                      icon={<Delete20Regular className="w-4 h-4" />}
                    >
                      {isDeleting ? t.aiAndToolchains.cleaningModel : t.aiAndToolchains.cleanModel}
                    </WinUIButton>
                  </div>
                </div>
              );
            })}
          </Card>
        ))}

      {/* Subtab 2: Rust Toolchains */}
      {subTab === "rust" &&
        (loadingRust ? (
          renderLoading("Inspecting Rustup installed toolchains and multi-gigabyte build targets...")
        ) : !rustData || rustData.toolchains.length === 0 ? (
          <EmptyState
            icon={<CheckmarkCircle20Filled className="text-[var(--success)]" />}
            title={t.aiAndToolchains.noToolchainsFound}
            description={t.aiAndToolchains.noToolchainsDesc}
          />
        ) : (
          <Card padded={false} className="overflow-hidden divide-y divide-[var(--border-divider)]">
            {rustData.toolchains.map((tc) => {
              const isDeleting = deletingToolchainName === tc.name;
              return (
                <div
                  key={tc.name}
                  className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">{tc.name}</span>
                      {tc.is_active && (
                        <Badge tone="success">
                          <CheckmarkCircle16Filled className="w-3.5 h-3.5" />
                          {t.aiAndToolchains.activeDefault}
                        </Badge>
                      )}
                      <Badge className="capitalize">{tc.channel}</Badge>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] truncate font-code">{tc.path}</p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                    <span className="text-sm font-semibold font-ibm-mono tabular-nums text-[var(--text-primary)] mr-1">
                      {formatBytes(tc.size_bytes)}
                    </span>
                    {renderReveal(tc.path)}
                    <WinUIButton
                      variant="standard"
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
                      icon={<Delete20Regular className="w-4 h-4" />}
                    >
                      {isDeleting ? t.aiAndToolchains.cleaningToolchain : t.aiAndToolchains.cleanToolchain}
                    </WinUIButton>
                  </div>
                </div>
              );
            })}
          </Card>
        ))}

      {/* Subtab 3: Conda Package Cache */}
      {subTab === "conda" &&
        (loadingConda ? (
          renderLoading("Inspecting Conda and Miniconda package tarball caches...")
        ) : !condaData || (!condaData.found && condaData.total_size_bytes === 0) ? (
          <EmptyState
            icon={<CheckmarkCircle20Filled className="text-[var(--success)]" />}
            title={t.aiAndToolchains.noCondaFound}
            description={t.aiAndToolchains.noCondaDesc}
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <Box20Regular className="w-5 h-5 text-[var(--text-secondary)] shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                    Conda & Miniconda Downloaded Package Tarballs
                  </h3>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {condaData.package_count} cached .conda and .tar.bz2 archives consuming{" "}
                    <strong className="font-ibm-mono text-[var(--text-primary)]">{formatBytes(condaData.total_size_bytes)}</strong>.
                  </p>
                </div>
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
                icon={<Delete20Regular className="w-4 h-4" />}
              >
                {cleaningConda
                  ? t.aiAndToolchains.cleaningConda
                  : `${t.aiAndToolchains.cleanConda} (${formatBytes(condaData.total_size_bytes)})`}
              </WinUIButton>
            </div>

            {condaData.cache_dirs.length > 0 && (
              <div className="border-t border-[var(--border-divider)]">
                <div className="px-4 pt-3 pb-1 text-xs text-[var(--text-secondary)]">Scanned Package Repositories:</div>
                <div className="divide-y divide-[var(--border-divider)]">
                  {condaData.cache_dirs.map((dir) => (
                    <div
                      key={dir}
                      className="px-4 py-2 flex items-center justify-between gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                    >
                      <span className="text-xs text-[var(--text-secondary)] font-code truncate">{dir}</span>
                      {renderReveal(dir)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        ))}

      {/* Confirmation modal */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <Card className="max-w-md w-full p-5 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Warning20Filled className="w-5 h-5 shrink-0 text-[var(--brand-amber)]" />
                <h3 className="font-semibold text-base text-[var(--text-primary)]">
                  {confirmTarget.type === "ai"
                    ? t.aiAndToolchains.confirmDeleteModel
                    : confirmTarget.type === "rust"
                    ? t.aiAndToolchains.confirmDeleteToolchain
                    : t.aiAndToolchains.confirmCleanConda}
                </h3>
              </div>
              <button
                onClick={() => setConfirmTarget(null)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] cursor-pointer"
                title={t.common.cancel}
              >
                <Dismiss16Regular className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-[var(--text-secondary)]">
              {confirmTarget.type === "ai"
                ? t.aiAndToolchains.confirmDeleteModelDesc
                : confirmTarget.type === "rust"
                ? t.aiAndToolchains.confirmDeleteToolchainDesc
                : t.aiAndToolchains.confirmCleanCondaDesc}
            </p>

            {confirmTarget.isActive && (
              <div className="px-3 py-2 rounded-md border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-sm text-[var(--danger)] flex items-center gap-2">
                <Warning20Filled className="w-4 h-4 shrink-0" />
                <span>{t.aiAndToolchains.activeToolchainWarning}</span>
              </div>
            )}

            <div className="rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] text-sm divide-y divide-[var(--border-divider)]">
              <div className="flex justify-between gap-3 px-3 py-2">
                <span className="text-[var(--text-secondary)]">{t.common.name}</span>
                <span className="font-medium text-[var(--text-primary)] truncate">{confirmTarget.name}</span>
              </div>
              <div className="flex justify-between gap-3 px-3 py-2">
                <span className="text-[var(--text-secondary)]">{t.common.size}</span>
                <span className="font-semibold font-ibm-mono text-[var(--text-primary)]">{formatBytes(confirmTarget.sizeBytes)}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton variant="standard" onClick={() => setConfirmTarget(null)}>
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
          </Card>
        </div>
      )}
    </div>
  );
};
