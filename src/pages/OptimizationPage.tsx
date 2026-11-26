import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import { Page, PageHeader, SectionTitle, Card, StatCard, Badge, FilterTabs } from "@/components/ui";
import {
  Gauge20Regular,
  Flash20Regular,
  Sparkle20Regular,
  HardDrive20Regular,
  Layer20Regular,
  ArrowClockwise20Regular,
  ArrowDownload20Regular,
  CheckmarkCircle20Filled,
  ShieldError20Filled,
  Delete20Regular,
  Info20Regular,
  Info16Regular,
  Shield16Regular,
  Folder20Regular,
  DocumentText20Regular,
  Search20Regular,
  Clock20Regular,
  ShieldCheckmark20Regular,
  WeatherMoon20Regular,
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
  const [virtRefreshToken, setVirtRefreshToken] = useState(0);

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
      icon: <DocumentText20Regular />,
    },
    {
      key: "show_hidden_files",
      title: t.optimization.showHiddenFilesTitle,
      badge: t.optimization.showHiddenFilesBadge,
      regName: "Hidden = 1",
      desc: t.optimization.showHiddenFilesDesc,
      footnote: t.optimization.showHiddenFilesFootnote,
      icon: <Folder20Regular />,
    },
    {
      key: "launch_this_pc",
      title: t.optimization.launchThisPcTitle,
      badge: t.optimization.launchThisPcBadge,
      regName: "LaunchTo = 1",
      desc: t.optimization.launchThisPcDesc,
      footnote: t.optimization.launchThisPcFootnote,
      icon: <HardDrive20Regular />,
    },
    {
      key: "disable_bing_search",
      title: t.optimization.disableBingSearchTitle,
      badge: t.optimization.disableBingSearchBadge,
      regName: "DisableSearchBoxSuggestions",
      desc: t.optimization.disableBingSearchDesc,
      footnote: t.optimization.disableBingSearchFootnote,
      icon: <Search20Regular />,
    },
    {
      key: "classic_context_menu",
      title: t.optimization.classicContextMenuTitle,
      badge: t.optimization.classicContextMenuBadge,
      regName: "ClassicShellClsid",
      desc: t.optimization.classicContextMenuDesc,
      footnote: t.optimization.classicContextMenuFootnote,
      icon: <Layer20Regular />,
    },
    {
      key: "enable_end_task",
      title: t.optimization.enableEndTaskTitle,
      badge: t.optimization.enableEndTaskBadge,
      regName: "TaskbarEndTask",
      desc: t.optimization.enableEndTaskDesc,
      footnote: t.optimization.enableEndTaskFootnote,
      icon: <Flash20Regular />,
    },
    {
      key: "show_seconds",
      title: t.optimization.showSecondsTitle,
      badge: t.optimization.showSecondsBadge,
      regName: "ShowSecondsInSystemClock",
      desc: t.optimization.showSecondsDesc,
      footnote: t.optimization.showSecondsFootnote,
      icon: <Clock20Regular />,
    },
    {
      key: "disable_advertising_id",
      title: t.optimization.disableAdvertisingIdTitle,
      badge: t.optimization.disableAdvertisingIdBadge,
      regName: "AdvertisingInfo\\Enabled = 0",
      desc: t.optimization.disableAdvertisingIdDesc,
      footnote: t.optimization.disableAdvertisingIdFootnote,
      icon: <ShieldCheckmark20Regular />,
    },
    {
      key: "disable_activity_upload",
      title: t.optimization.disableActivityUploadTitle,
      badge: t.optimization.disableActivityUploadBadge,
      regName: "PublishUserActivities = 0",
      desc: t.optimization.disableActivityUploadDesc,
      footnote: t.optimization.disableActivityUploadFootnote,
      icon: <Info20Regular />,
    },
    {
      key: "enable_long_paths",
      title: t.optimization.enableLongPathsTitle,
      badge: t.optimization.enableLongPathsBadge,
      regName: "LongPathsEnabled = 1",
      desc: t.optimization.enableLongPathsDesc,
      footnote: t.optimization.enableLongPathsFootnote,
      icon: <Folder20Regular />,
    },
    {
      key: "reduce_menu_delay",
      title: t.optimization.reduceMenuDelayTitle,
      badge: t.optimization.reduceMenuDelayBadge,
      regName: "MenuShowDelay = 20ms",
      desc: t.optimization.reduceMenuDelayDesc,
      footnote: t.optimization.reduceMenuDelayFootnote,
      icon: <Flash20Regular />,
    },
    {
      key: "disable_game_dvr",
      title: t.optimization.disableGameDvrTitle,
      badge: t.optimization.disableGameDvrBadge,
      regName: "GameDVR_Enabled = 0",
      desc: t.optimization.disableGameDvrDesc,
      footnote: t.optimization.disableGameDvrFootnote,
      icon: <Sparkle20Regular />,
    },
    {
      key: "disable_copilot",
      title: t.optimization.disableCopilotTitle,
      badge: t.optimization.disableCopilotBadge,
      regName: "TurnOffWindowsCopilot = 1",
      desc: t.optimization.disableCopilotDesc,
      footnote: t.optimization.disableCopilotFootnote,
      icon: <Sparkle20Regular />,
    },
    {
      key: "disable_ntfs_last_access",
      title: t.optimization.disableNtfsLastAccessTitle,
      badge: t.optimization.disableNtfsLastAccessBadge,
      regName: "NtfsDisableLastAccessUpdate",
      desc: t.optimization.disableNtfsLastAccessDesc,
      footnote: t.optimization.disableNtfsLastAccessFootnote,
      icon: <HardDrive20Regular />,
    },
  ];

  const isSystemTab = activeTab === "system";

  return (
    <Page className="select-none">
      <PageHeader
        icon={<Gauge20Regular />}
        title={t.optimization.title}
        description={isSystemTab ? t.optimization.subtitle : t.virtualization.subtitle}
        actions={
          <WinUIButton
            variant="standard"
            onClick={isSystemTab ? loadOverview : () => setVirtRefreshToken((n) => n + 1)}
            disabled={isSystemTab && loading}
            icon={<ArrowClockwise20Regular className={`w-4 h-4 ${isSystemTab && loading ? "animate-spin" : ""}`} />}
          >
            {isSystemTab && loading ? t.common.scanning : t.common.refresh}
          </WinUIButton>
        }
      />

      <FilterTabs<"system" | "virtualization">
        items={[
          { id: "system", label: t.virtualization.tabSystem },
          { id: "virtualization", label: t.virtualization.tabVirtualization },
        ]}
        value={activeTab}
        onChange={setActiveTab}
      />

      {isSystemTab ? (
        <>
          {/* Notice */}
          {statusMessage && (
            <Card className="py-2.5 flex items-center justify-between gap-3 animate-fadeIn">
              <div className="flex items-center gap-2 min-w-0">
                {statusMessage.type === "success" ? (
                  <CheckmarkCircle20Filled className="w-4 h-4 shrink-0 text-[var(--success)]" />
                ) : (
                  <ShieldError20Filled className="w-4 h-4 shrink-0 text-[var(--danger)]" />
                )}
                <span
                  className={`text-sm ${
                    statusMessage.type === "success" ? "text-[var(--text-primary)]" : "text-[var(--danger)]"
                  }`}
                >
                  {statusMessage.text}
                </span>
              </div>
              <WinUIButton variant="subtle" size="sm" onClick={() => setStatusMessage(null)}>
                {t.common.close}
              </WinUIButton>
            </Card>
          )}

          {/* Stat row */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.optimization.hibernationTitle}
              value={overview?.hibernation_enabled ? formatBytes(overview.hibernation_size_bytes || 0) : "0 B"}
              hint={overview?.hibernation_enabled ? t.optimization.hibernationReserved : t.optimization.hibernationDisabledSaved}
              icon={<WeatherMoon20Regular />}
            />
            <StatCard
              label={t.optimization.storageSenseTitle}
              value={
                <span className="font-sans">
                  {overview?.storage_sense_enabled ? t.common.enabled : t.common.disabled}
                </span>
              }
              hint={t.optimization.storageSenseCurrentStatus}
              icon={<Sparkle20Regular />}
              tone={overview?.storage_sense_enabled ? "success" : "neutral"}
            />
            <StatCard
              label={t.optimization.deliveryTitle}
              value={formatBytes(overview?.delivery_cache_bytes || 0)}
              hint={t.optimization.deliveryCachedData}
              icon={<ArrowDownload20Regular />}
            />
            <StatCard
              label={t.optimization.pagefileTitle}
              value={formatBytes(overview?.paging_total_bytes || 0)}
              hint={t.optimization.pagefileManaged}
              icon={<Layer20Regular />}
            />
          </div>

          {/* System features */}
          <SectionTitle>{t.optimization.systemFeatureControls}</SectionTitle>
          <Card padded={false} className="overflow-hidden">
            <div className="divide-y divide-[var(--border-divider)]">
              <SettingRow
                icon={<WeatherMoon20Regular />}
                title={t.optimization.hibernationTitle}
                meta="C:\hiberfil.sys"
                description={t.optimization.hibernationDesc}
                footnote={t.optimization.hibernationFootnote}
                adminNote={t.optimization.adminNotice}
                valueLabel={t.optimization.hibernationCurrentFootprint}
                value={overview?.hibernation_size_bytes ? formatBytes(overview.hibernation_size_bytes) : "0 B"}
                control={
                  <span className="w-[92px] flex">
                    <WinUIToggle
                    checked={overview?.hibernation_enabled || false}
                    disabled={togglingHiber || !overview}
                    onChange={handleToggleHibernation}
                    labelOn={t.common.enabled}
                    labelOff={t.common.disabled}
                  />
                  </span>
                }
              />

              <SettingRow
                icon={<Sparkle20Regular />}
                title={t.optimization.storageSenseTitle}
                description={t.optimization.storageSenseDesc}
                footnote={t.optimization.storageSenseFootnote}
                valueLabel={t.optimization.storageSenseCurrentStatus}
                value={
                  <span
                    className={`font-sans ${
                      overview?.storage_sense_enabled ? "text-[var(--success)]" : "text-[var(--text-secondary)]"
                    }`}
                  >
                    {overview?.storage_sense_enabled ? t.optimization.storageSenseActive : t.optimization.storageSenseOff}
                  </span>
                }
                control={
                  <span className="w-[92px] flex">
                    <WinUIToggle
                    checked={overview?.storage_sense_enabled || false}
                    disabled={togglingSense || !overview}
                    onChange={handleToggleStorageSense}
                    labelOn={t.common.enabled}
                    labelOff={t.common.disabled}
                  />
                  </span>
                }
              />

              <SettingRow
                icon={<ArrowDownload20Regular />}
                title={t.optimization.deliveryTitle}
                description={t.optimization.deliveryDesc}
                path="SoftwareDistribution\DeliveryOptimization"
                adminNote={t.optimization.adminNotice}
                valueLabel={t.optimization.deliveryCachedData}
                value={formatBytes(overview?.delivery_cache_bytes || 0)}
                control={
                  <WinUIButton
                    variant="standard"
                    onClick={handleCleanDeliveryCache}
                    disabled={cleaningDelivery || (overview?.delivery_cache_bytes || 0) === 0}
                    icon={
                      cleaningDelivery ? (
                        <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                      ) : (
                        <Delete20Regular className="w-4 h-4" />
                      )
                    }
                  >
                    {cleaningDelivery ? t.common.deleting : t.optimization.deliveryClean}
                  </WinUIButton>
                }
              />

              <SettingRow
                icon={<Layer20Regular />}
                title={t.optimization.pagefileTitle}
                meta="pagefile.sys"
                description={t.optimization.pagefileDesc}
                path={`${t.optimization.pagefileLocations} ${overview?.paging_files.join(", ") || "C:\\pagefile.sys"}`}
                valueLabel={t.optimization.pagefileAllocated}
                value={formatBytes(overview?.paging_total_bytes || 0)}
                control={<Badge>{t.optimization.pagefileManaged}</Badge>}
              />
            </div>
          </Card>

          {/* Explorer and shell tweaks */}
          <SectionTitle
            action={<span className="text-xs text-[var(--text-muted)]">{t.optimization.registryTuning}</span>}
          >
            {t.optimization.explorerTweaksTitle}
          </SectionTitle>
          <Card padded={false} className="overflow-hidden">
            <div className="divide-y divide-[var(--border-divider)]">
              {explorerTweaks.map((item) => {
                const isEnabled = Boolean(overview?.explorer_settings?.[item.key]);
                return (
                  <SettingRow
                    key={item.key}
                    icon={item.icon}
                    title={item.title}
                    badge={item.badge}
                    meta={item.regName}
                    description={item.desc}
                    footnote={item.footnote}
                    control={
                      <span title={t.optimization.currentState} className="w-[92px] flex">
                        <WinUIToggle
                          checked={isEnabled}
                          disabled={togglingExplorer === item.key || !overview}
                          onChange={() => handleToggleExplorerSetting(item.key, item.title)}
                          labelOn={t.common.enabled}
                          labelOff={t.common.disabled}
                        />
                      </span>
                    }
                  />
                );
              })}
            </div>
          </Card>
        </>
      ) : (
        <VirtualizationView refreshToken={virtRefreshToken} />
      )}
    </Page>
  );
};

/* A Windows-Settings style row: icon tile, title and description, the current value and a control on the right. */
const SettingRow: React.FC<{
  icon: React.ReactNode;
  title: React.ReactNode;
  badge?: React.ReactNode;
  meta?: React.ReactNode;
  description: React.ReactNode;
  footnote?: React.ReactNode;
  path?: React.ReactNode;
  adminNote?: React.ReactNode;
  valueLabel?: React.ReactNode;
  value?: React.ReactNode;
  control: React.ReactNode;
}> = ({ icon, title, badge, meta, description, footnote, path, adminNote, valueLabel, value, control }) => (
  <div className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors">
    <div className="flex items-start gap-3 flex-1 min-w-0">
      <div className="w-9 h-9 rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center shrink-0 text-[var(--text-secondary)] [&_svg]:w-5 [&_svg]:h-5">
        {icon}
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
          {badge && <Badge>{badge}</Badge>}
          {meta && <span className="font-code text-xs text-[var(--text-muted)]">{meta}</span>}
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{description}</p>
        {path && <div className="font-code text-xs text-[var(--text-muted)] truncate">{path}</div>}
        {footnote && (
          <div className="flex items-start gap-1.5 text-xs text-[var(--text-muted)] pt-0.5">
            <Info16Regular className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{footnote}</span>
          </div>
        )}
        {adminNote && (
          <div className="flex items-start gap-1.5 text-xs text-[var(--brand-amber)] pt-0.5">
            <Shield16Regular className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{adminNote}</span>
          </div>
        )}
      </div>
    </div>

    <div className="flex items-center gap-4 shrink-0 self-end md:self-center">
      {value !== undefined && (
        <div className="text-right">
          {valueLabel && <div className="text-xs text-[var(--text-muted)]">{valueLabel}</div>}
          <div className="text-sm font-semibold font-ibm-mono text-[var(--text-primary)]">{value}</div>
        </div>
      )}
      {control}
    </div>
  </div>
);

export default OptimizationPage;
