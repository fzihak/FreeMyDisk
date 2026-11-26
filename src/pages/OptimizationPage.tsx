import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import {
  Gauge24Filled,
  Flash20Filled,
  Sparkle20Filled,
  HardDrive20Regular,
  Layer20Regular,
  ArrowClockwise20Regular,
  CheckmarkCircle20Filled,
  ShieldError20Filled,
  Delete20Regular,
  Info20Regular,
  Folder20Regular,
  DocumentText20Regular,
  Search20Regular,
  Settings20Regular,
  Clock20Regular,
  ShieldCheckmark20Regular,
  Server20Filled,
} from "@fluentui/react-icons";
import { VirtualizationView } from "@/components/optimization/VirtualizationView";

export interface ExplorerSettings {
  show_file_extensions: boolean;
  show_hidden_files: boolean;
  launch_this_pc: boolean;
  disable_bing_search: boolean;
  classic_context_menu: boolean;
  enable_end_task: boolean;
  show_seconds: boolean;
  disable_advertising_id: boolean;
  disable_activity_upload: boolean;
  enable_long_paths: boolean;
  reduce_menu_delay: boolean;
  disable_game_dvr: boolean;
  disable_copilot: boolean;
  disable_ntfs_last_access: boolean;
}

export interface SystemOptimizationOverview {
  hibernation_enabled: boolean;
  hibernation_size_bytes: number | null;
  storage_sense_enabled: boolean;
  delivery_cache_bytes: number;
  paging_total_bytes: number;
  paging_files: string[];
  explorer_settings?: ExplorerSettings;
}

interface ExplorerTweakItem {
  key: keyof ExplorerSettings;
  title: string;
  badge: string;
  regName: string;
  desc: string;
  footnote: string;
  icon: React.ReactNode;
  iconColor: string;
}

export const OptimizationPage: React.FC = () => {
  const { t } = useI18nStore();
  const [overview, setOverview] = useState<SystemOptimizationOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [togglingHiber, setTogglingHiber] = useState(false);
  const [togglingSense, setTogglingSense] = useState(false);
  const [cleaningDelivery, setCleaningDelivery] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [togglingExplorer, setTogglingExplorer] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"system" | "virtualization">("system");

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const loadOverview = async () => {
    setLoading(true);
    try {
      const res = await invoke<SystemOptimizationOverview>("get_optimization_overview");
      setOverview(res);
    } catch (e) {
      console.error("Failed to load optimization overview:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const handleToggleHibernation = async () => {
    if (!overview) return;
    setTogglingHiber(true);
    setStatusMessage(null);
    try {
      const next = !overview.hibernation_enabled;
      await invoke("toggle_hibernation", { enable: next });
      setStatusMessage({
        type: "success",
        text: next
          ? t.optimization.hibernationReserved
          : t.optimization.hibernationDisabledSaved,
      });
      setTimeout(() => setStatusMessage(null), 5000);
      await loadOverview();
    } catch (e) {
      setStatusMessage({
        type: "error",
        text: String(e).includes("Administrator")
          ? String(e)
          : `${t.common.error}: ${e}`,
      });
    } finally {
      setTogglingHiber(false);
    }
  };

  const handleToggleStorageSense = async () => {
    if (!overview) return;
    setTogglingSense(true);
    setStatusMessage(null);
    try {
      const next = !overview.storage_sense_enabled;
      await invoke("toggle_storage_sense", { enable: next });
      setStatusMessage({
        type: "success",
        text: next
          ? t.optimization.storageSenseActive
          : t.optimization.storageSenseOff,
      });
      setTimeout(() => setStatusMessage(null), 5000);
      await loadOverview();
    } catch (e) {
      setStatusMessage({
        type: "error",
        text: `${t.common.error}: ${e}`,
      });
    } finally {
      setTogglingSense(false);
    }
  };

  const handleCleanDeliveryCache = async () => {
    setCleaningDelivery(true);
    setStatusMessage(null);
    try {
      const reclaimed = await invoke<number>("clean_delivery_cache");
      setStatusMessage({
        type: "success",
        text: `${t.optimization.deliveryTitle}: ${formatBytes(reclaimed)} ${t.cleanup.reclaimedSpace}`,
      });
      setTimeout(() => setStatusMessage(null), 6000);
      await loadOverview();
    } catch (e) {
      setStatusMessage({
        type: "error",
        text: String(e).includes("Administrator")
          ? String(e)
          : `${t.common.error}: ${e}`,
      });
    } finally {
      setCleaningDelivery(false);
    }
  };

  const handleToggleExplorerSetting = async (
    key: keyof ExplorerSettings,
    label: string
  ) => {
    if (!overview || !overview.explorer_settings) return;
    setTogglingExplorer(key);
    setStatusMessage(null);
    try {
      const next = !overview.explorer_settings[key];
      await invoke("set_explorer_setting", { settingKey: key, enable: next });
      setStatusMessage({
        type: "success",
        text: `${label}: ${next ? t.common.enabled : t.common.disabled}. ${t.optimization.changesBroadcast}`,
      });
      setTimeout(() => setStatusMessage(null), 5000);
      await loadOverview();
    } catch (e) {
      setStatusMessage({
        type: "error",
        text: `${t.common.error} (${label}): ${e}`,
      });
    } finally {
      setTogglingExplorer(null);
    }
  };

  const explorerTweaks: ExplorerTweakItem[] = [
    {
      key: "show_file_extensions",
      title: t.optimization.showFileExtensionsTitle,
      badge: t.optimization.showFileExtensionsBadge,
      regName: "HideFileExt",
      desc: t.optimization.showFileExtensionsDesc,
      footnote: t.optimization.showFileExtensionsFootnote,
      icon: <DocumentText20Regular className="w-5 h-5 text-blue-400" />,
      iconColor: "bg-blue-500/10 border-blue-500/20 text-blue-400",
    },
    {
      key: "show_hidden_files",
      title: t.optimization.showHiddenFilesTitle,
      badge: t.optimization.showHiddenFilesBadge,
      regName: "Hidden = 1",
      desc: t.optimization.showHiddenFilesDesc,
      footnote: t.optimization.showHiddenFilesFootnote,
      icon: <Folder20Regular className="w-5 h-5 text-teal-400" />,
      iconColor: "bg-teal-500/10 border-teal-500/20 text-teal-400",
    },
    {
      key: "launch_this_pc",
      title: t.optimization.launchThisPcTitle,
      badge: t.optimization.launchThisPcBadge,
      regName: "LaunchTo = 1",
      desc: t.optimization.launchThisPcDesc,
      footnote: t.optimization.launchThisPcFootnote,
      icon: <HardDrive20Regular className="w-5 h-5 text-indigo-400" />,
      iconColor: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
    },
    {
      key: "disable_bing_search",
      title: t.optimization.disableBingSearchTitle,
      badge: t.optimization.disableBingSearchBadge,
      regName: "DisableSearchBoxSuggestions",
      desc: t.optimization.disableBingSearchDesc,
      footnote: t.optimization.disableBingSearchFootnote,
      icon: <Search20Regular className="w-5 h-5 text-cyan-400" />,
      iconColor: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400",
    },
    {
      key: "classic_context_menu",
      title: t.optimization.classicContextMenuTitle,
      badge: t.optimization.classicContextMenuBadge,
      regName: "ClassicShellClsid",
      desc: t.optimization.classicContextMenuDesc,
      footnote: t.optimization.classicContextMenuFootnote,
      icon: <Layer20Regular className="w-5 h-5 text-violet-400" />,
      iconColor: "bg-violet-500/10 border-violet-500/20 text-violet-400",
    },
    {
      key: "enable_end_task",
      title: t.optimization.enableEndTaskTitle,
      badge: t.optimization.enableEndTaskBadge,
      regName: "TaskbarEndTask",
      desc: t.optimization.enableEndTaskDesc,
      footnote: t.optimization.enableEndTaskFootnote,
      icon: <Flash20Filled className="w-5 h-5 text-rose-400" />,
      iconColor: "bg-rose-500/10 border-rose-500/20 text-rose-400",
    },
    {
      key: "show_seconds",
      title: t.optimization.showSecondsTitle,
      badge: t.optimization.showSecondsBadge,
      regName: "ShowSecondsInSystemClock",
      desc: t.optimization.showSecondsDesc,
      footnote: t.optimization.showSecondsFootnote,
      icon: <Clock20Regular className="w-5 h-5 text-emerald-400" />,
      iconColor: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    },
    {
      key: "disable_advertising_id",
      title: t.optimization.disableAdvertisingIdTitle,
      badge: t.optimization.disableAdvertisingIdBadge,
      regName: "AdvertisingInfo\\Enabled = 0",
      desc: t.optimization.disableAdvertisingIdDesc,
      footnote: t.optimization.disableAdvertisingIdFootnote,
      icon: <ShieldCheckmark20Regular className="w-5 h-5 text-sky-400" />,
      iconColor: "bg-sky-500/10 border-sky-500/20 text-sky-400",
    },
    {
      key: "disable_activity_upload",
      title: t.optimization.disableActivityUploadTitle,
      badge: t.optimization.disableActivityUploadBadge,
      regName: "PublishUserActivities = 0",
      desc: t.optimization.disableActivityUploadDesc,
      footnote: t.optimization.disableActivityUploadFootnote,
      icon: <Info20Regular className="w-5 h-5 text-slate-400" />,
      iconColor: "bg-slate-500/10 border-slate-500/20 text-slate-400",
    },
    {
      key: "enable_long_paths",
      title: t.optimization.enableLongPathsTitle,
      badge: t.optimization.enableLongPathsBadge,
      regName: "LongPathsEnabled = 1",
      desc: t.optimization.enableLongPathsDesc,
      footnote: t.optimization.enableLongPathsFootnote,
      icon: <Folder20Regular className="w-5 h-5 text-amber-400" />,
      iconColor: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    },
    {
      key: "reduce_menu_delay",
      title: t.optimization.reduceMenuDelayTitle,
      badge: t.optimization.reduceMenuDelayBadge,
      regName: "MenuShowDelay = 20ms",
      desc: t.optimization.reduceMenuDelayDesc,
      footnote: t.optimization.reduceMenuDelayFootnote,
      icon: <Flash20Filled className="w-5 h-5 text-lime-400" />,
      iconColor: "bg-lime-500/10 border-lime-500/20 text-lime-400",
    },
    {
      key: "disable_game_dvr",
      title: t.optimization.disableGameDvrTitle,
      badge: t.optimization.disableGameDvrBadge,
      regName: "GameDVR_Enabled = 0",
      desc: t.optimization.disableGameDvrDesc,
      footnote: t.optimization.disableGameDvrFootnote,
      icon: <Sparkle20Filled className="w-5 h-5 text-fuchsia-400" />,
      iconColor: "bg-fuchsia-500/10 border-fuchsia-500/20 text-fuchsia-400",
    },
    {
      key: "disable_copilot",
      title: t.optimization.disableCopilotTitle,
      badge: t.optimization.disableCopilotBadge,
      regName: "TurnOffWindowsCopilot = 1",
      desc: t.optimization.disableCopilotDesc,
      footnote: t.optimization.disableCopilotFootnote,
      icon: <Sparkle20Filled className="w-5 h-5 text-orange-400" />,
      iconColor: "bg-orange-500/10 border-orange-500/20 text-orange-400",
    },
    {
      key: "disable_ntfs_last_access",
      title: t.optimization.disableNtfsLastAccessTitle,
      badge: t.optimization.disableNtfsLastAccessBadge,
      regName: "NtfsDisableLastAccessUpdate",
      desc: t.optimization.disableNtfsLastAccessDesc,
      footnote: t.optimization.disableNtfsLastAccessFootnote,
      icon: <HardDrive20Regular className="w-5 h-5 text-emerald-400" />,
      iconColor: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center shrink-0 ${
              activeTab === "system" ? "text-amber-400" : "text-blue-400"
            }`}
          >
            {activeTab === "system" ? (
              <Gauge24Filled className="w-6 h-6" />
            ) : (
              <Server20Filled className="w-6 h-6" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {activeTab === "system" ? t.optimization.title : t.virtualization.title}
              </h1>
              <span
                className={`px-2 py-0.5 rounded-[4px] text-xs font-ibm-mono uppercase tracking-wider border ${
                  activeTab === "system"
                    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                }`}
              >
                {activeTab === "system" ? t.optimization.windowsFeatures : "WSL2 • DOCKER • VM"}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {activeTab === "system" ? t.optimization.subtitle : t.virtualization.subtitle}
            </p>
          </div>
        </div>

        {activeTab === "system" && (
          <WinUIButton
            variant="standard"
            onClick={loadOverview}
            disabled={loading}
            className="flex items-center gap-1.5 self-start sm:self-auto shrink-0"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{loading ? t.common.scanning : t.common.refresh}</span>
          </WinUIButton>
        )}
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex border-b border-[var(--border-subtle)] gap-2">
        <button
          onClick={() => setActiveTab("system")}
          className={`flex items-center gap-2 pb-3 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
            activeTab === "system"
              ? "border-amber-400 text-[var(--text-primary)]"
              : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Gauge24Filled className="w-4 h-4 text-amber-400" />
          <span>{t.virtualization.tabSystem}</span>
        </button>
        <button
          onClick={() => setActiveTab("virtualization")}
          className={`flex items-center gap-2 pb-3 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
            activeTab === "virtualization"
              ? "border-blue-400 text-[var(--text-primary)]"
              : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Server20Filled className="w-4 h-4 text-blue-400" />
          <span>{t.virtualization.tabVirtualization}</span>
        </button>
      </div>

      {activeTab === "system" ? (
        <>
          {/* Notification Banner */}
      {statusMessage && (
        <div
          className={`p-4 rounded-lg flex items-center justify-between animate-fadeIn border shadow-sm ${
            statusMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-rose-500/10 border-rose-500/30 text-rose-400"
          }`}
        >
          <div className="flex items-center gap-3 text-xs font-medium">
            {statusMessage.type === "success" ? (
              <CheckmarkCircle20Filled className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <ShieldError20Filled className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-xs hover:underline cursor-pointer ml-4 shrink-0 opacity-80 hover:opacity-100"
          >
            {t.common.close}
          </button>
        </div>
      )}

      {/* 4-Tile Stat Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-ibm-mono">
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.optimization.hibernationTitle}</span>
            <Flash20Filled className="w-4 h-4 text-amber-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-amber-400 tabular-nums">
              {overview?.hibernation_enabled
                ? formatBytes(overview.hibernation_size_bytes || 0)
                : "0 B"}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {overview?.hibernation_enabled ? t.optimization.hibernationReserved : t.optimization.hibernationDisabledSaved}
            </div>
          </div>
        </WinUICard>

        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.optimization.storageSenseTitle}</span>
            <Sparkle20Filled className="w-4 h-4 text-cyan-400 shrink-0" />
          </div>
          <div>
            <div className={`text-2xl font-bold font-sans ${overview?.storage_sense_enabled ? "text-cyan-400" : "text-[var(--text-muted)]"}`}>
              {overview?.storage_sense_enabled ? t.common.enabled : t.common.disabled}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {t.optimization.storageSenseCurrentStatus}
            </div>
          </div>
        </WinUICard>

        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.optimization.deliveryTitle}</span>
            <HardDrive20Regular className="w-4 h-4 text-purple-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-purple-400 tabular-nums">
              {formatBytes(overview?.delivery_cache_bytes || 0)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {t.optimization.deliveryCachedData}
            </div>
          </div>
        </WinUICard>

        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.optimization.pagefileTitle}</span>
            <Layer20Regular className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald-400 tabular-nums">
              {formatBytes(overview?.paging_total_bytes || 0)}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {t.optimization.pagefileManaged}
            </div>
          </div>
        </WinUICard>
      </div>

      {/* Main Feature Settings */}
      <div className="space-y-3 pt-2">
        <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">
          {t.optimization.systemFeatureControls}
        </h2>

        <WinUICard className="divide-y divide-[var(--border-divider)]">
          {/* 1. Hibernation Manager */}
          <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <Flash20Filled className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                    {t.optimization.hibernationTitle}
                  </h3>
                  <span className="text-xs font-ibm-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                    {t.optimization.adminNotice}
                  </span>
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                    C:\hiberfil.sys
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                  {t.optimization.hibernationDesc}
                </p>
                <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 pt-1">
                  <Info20Regular className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>{t.optimization.hibernationFootnote}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
              <div className="text-right font-ibm-mono">
                <div className="text-xs text-[var(--text-muted)] font-sans">{t.optimization.hibernationCurrentFootprint}</div>
                <div className="text-sm font-bold text-amber-400 tabular-nums">
                  {overview?.hibernation_size_bytes ? formatBytes(overview.hibernation_size_bytes) : "0 B"}
                </div>
              </div>
              <div className="pl-2 border-l border-[var(--border-divider)]">
                <WinUIToggle
                  checked={overview?.hibernation_enabled || false}
                  disabled={togglingHiber || !overview}
                  onChange={handleToggleHibernation}
                  labelOn={t.common.enabled}
                  labelOff={t.common.disabled}
                />
              </div>
            </div>
          </div>

          {/* 2. Storage Sense Automated Cleaner */}
          <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkle20Filled className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                    {t.optimization.storageSenseTitle}
                  </h3>
                  <span className="text-xs font-ibm-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-medium">
                    Windows
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                  {t.optimization.storageSenseDesc}
                </p>
                <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 pt-1">
                  <Info20Regular className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span>{t.optimization.storageSenseFootnote}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
              <div className="text-right font-sans">
                <div className="text-xs text-[var(--text-muted)]">{t.optimization.storageSenseCurrentStatus}</div>
                <div className={`text-sm font-semibold ${overview?.storage_sense_enabled ? "text-cyan-400" : "text-[var(--text-muted)]"}`}>
                  {overview?.storage_sense_enabled ? t.optimization.storageSenseActive : t.optimization.storageSenseOff}
                </div>
              </div>
              <div className="pl-2 border-l border-[var(--border-divider)]">
                <WinUIToggle
                  checked={overview?.storage_sense_enabled || false}
                  disabled={togglingSense || !overview}
                  onChange={handleToggleStorageSense}
                  labelOn={t.common.enabled}
                  labelOff={t.common.disabled}
                />
              </div>
            </div>
          </div>

          {/* 3. Delivery Optimization Cache */}
          <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <HardDrive20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                    {t.optimization.deliveryTitle}
                  </h3>
                  <span className="text-xs font-ibm-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                    {t.optimization.adminNotice}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                  {t.optimization.deliveryDesc}
                </p>
                <div className="text-xs text-[var(--text-muted)] font-ibm-mono truncate pt-1">
                  SoftwareDistribution\DeliveryOptimization
                </div>
              </div>
            </div>

            <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
              <div className="text-right font-ibm-mono">
                <div className="text-xs text-[var(--text-muted)] font-sans">{t.optimization.deliveryCachedData}</div>
                <div className="text-sm font-bold text-purple-400 tabular-nums">
                  {formatBytes(overview?.delivery_cache_bytes || 0)}
                </div>
              </div>
              <div className="pl-2 border-l border-[var(--border-divider)]">
                <WinUIButton
                  variant="primary"
                  onClick={handleCleanDeliveryCache}
                  disabled={cleaningDelivery || (overview?.delivery_cache_bytes || 0) === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white"
                >
                  <Delete20Regular className="w-4 h-4" />
                  <span>{cleaningDelivery ? t.common.deleting : t.optimization.deliveryClean}</span>
                </WinUIButton>
              </div>
            </div>
          </div>

          {/* 4. Virtual Memory & Paging File */}
          <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <Layer20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                    {t.optimization.pagefileTitle}
                  </h3>
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                    pagefile.sys
                  </span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                  {t.optimization.pagefileDesc}
                </p>
                <div className="text-xs text-[var(--text-muted)] font-ibm-mono pt-1">
                  {t.optimization.pagefileLocations} {overview?.paging_files.join(", ") || "C:\\pagefile.sys"}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
              <div className="text-right font-ibm-mono">
                <div className="text-xs text-[var(--text-muted)] font-sans">{t.optimization.pagefileAllocated}</div>
                <div className="text-sm font-bold text-emerald-400 tabular-nums">
                  {formatBytes(overview?.paging_total_bytes || 0)}
                </div>
              </div>
              <div className="pl-2 border-l border-[var(--border-divider)]">
                <span className="px-3 py-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold font-ibm-mono">
                  {t.optimization.pagefileManaged}
                </span>
              </div>
            </div>
          </div>
        </WinUICard>
      </div>

      {/* Windows Explorer & Shell Tweaks */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Settings20Regular className="w-4 h-4 text-blue-400" />
            <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {t.optimization.explorerTweaksTitle}
            </h2>
          </div>
          <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
            {t.optimization.registryTuning}
          </span>
        </div>

        <WinUICard className="divide-y divide-[var(--border-divider)]">
          {explorerTweaks.map((item) => {
            const isEnabled = Boolean(overview?.explorer_settings?.[item.key]);

            return (
              <div
                key={item.key}
                className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:bg-white/[0.015] transition-colors"
              >
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${item.iconColor}`}>
                    {item.icon}
                  </div>
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                        {item.title}
                      </h3>
                      <span className="text-xs font-ibm-mono px-2 py-0.5 rounded bg-white/[0.06] text-[var(--text-secondary)] border border-[var(--border-subtle)] font-medium">
                        {item.badge}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
                        {item.regName}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                      {item.desc}
                    </p>
                    <div className="text-xs text-[var(--text-muted)] flex items-center gap-1.5 pt-1">
                      <Info20Regular className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      <span>{item.footnote}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-6 shrink-0 self-end md:self-center">
                  <div className="text-right font-sans">
                    <div className="text-xs text-[var(--text-muted)]">{t.optimization.currentState}</div>
                    <div className={`text-sm font-semibold ${isEnabled ? "text-emerald-400" : "text-[var(--text-muted)]"}`}>
                      {isEnabled ? t.common.enabled : t.common.disabled}
                    </div>
                  </div>
                  <div className="pl-2 border-l border-[var(--border-divider)]">
                    <WinUIToggle
                      checked={isEnabled}
                      disabled={togglingExplorer === item.key || !overview}
                      onChange={() => handleToggleExplorerSetting(item.key, item.title)}
                      labelOn={t.common.enabled}
                      labelOff={t.common.disabled}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </WinUICard>
      </div>
      </>
      ) : (
        <VirtualizationView />
      )}
    </div>
  );
};

export default OptimizationPage;
