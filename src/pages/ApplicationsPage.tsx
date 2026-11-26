import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { toast } from "@/stores/toast-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState, ActionBar } from "@/components/ui";
import {
  Apps20Regular,
  ArrowClockwise20Regular,
  Search20Regular,
  Open20Regular,
  Delete20Regular,
  FolderDismiss20Regular,
  Pulse20Regular,
  CheckmarkCircle20Regular,
  HardDrive20Regular,
  ArrowSort20Regular,
  Layer20Regular,
  FolderOpen20Regular,
  Flash20Regular,
  DismissCircle20Regular,
  Sparkle20Regular,
  DocumentBulletList20Regular,
  Folder20Regular,
  Info20Regular,
} from "@fluentui/react-icons";

const controlClass =
  "h-8 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50";

const confidenceTone = (c: string): "success" | "warning" | "neutral" => {
  const v = c.toLowerCase();
  return v === "high" ? "success" : v === "medium" ? "warning" : "neutral";
};

/** App icon tile: the real extracted icon when available, initials otherwise. */
const AppIcon: React.FC<{ src?: string | null; name: string; fallback: string }> = ({ src, name, fallback }) =>
  src ? (
    <img
      src={src}
      alt={name}
      className="w-8 h-8 object-contain rounded-md p-1 bg-[var(--fill-subtle)] shrink-0"
    />
  ) : (
    <span className="w-8 h-8 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-xs font-semibold text-[var(--text-secondary)] shrink-0 font-ibm-mono">
      {name.trim().slice(0, 2).toUpperCase() || fallback}
    </span>
  );

/** Busy card for scans without backend progress events: indeterminate bar. */
const BusyCard: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <Card className="space-y-3">
    <div className="flex items-center gap-2">
      <ArrowClockwise20Regular className="w-4 h-4 animate-spin text-[var(--accent-text)]" />
      <span className="text-sm font-semibold text-[var(--text-primary)]">{title}</span>
    </div>
    {subtitle && <div className="text-xs text-[var(--text-secondary)]">{subtitle}</div>}
    <ProgressBar value={100} className="animate-pulse" />
  </Card>
);

export interface InstalledAppInfo {
  id: string;
  name: string;
  publisher: string | null;
  display_version: string | null;
  install_location: string | null;
  uninstall_string: string | null;
  estimated_size_bytes: number | null;
  install_date: string | null;
  is_running: boolean;
  display_icon?: string | null;
  icon_data?: string | null;
}

export interface UwpAppInfo {
  name: string;
  display_name: string;
  publisher: string | null;
  package_full_name: string;
  install_location: string | null;
  version: string | null;
  estimated_size_bytes: number | null;
  icon_path?: string | null;
  icon_data_url?: string | null;
}

export interface LeftoverCandidate {
  id: string;
  path_or_key: string;
  kind: "filesystem" | "registry";
  size_bytes: number;
  item_count: number;
  confidence: "high" | "medium" | "low" | string;
  description: string;
}

export interface LeftoverGroup {
  id: string;
  app_name: string;
  publisher?: string | null;
  items: LeftoverCandidate[];
  total_size_bytes: number;
  overall_confidence: "high" | "medium" | "low" | string;
}

interface LeftoverCleanSummary {
  freed_bytes: number;
  removed_folders: number;
  removed_registry_keys: number;
  failed: string[];
}

export interface UninstallResult {
  app_id: string;
  app_name: string;
  success: boolean;
  message: string;
  leftovers?: LeftoverGroup | null;
}

export const ApplicationsPage: React.FC = () => {
  const { t } = useI18nStore();
  const [activeTab, setActiveTab] = useState<"installed" | "uwp" | "leftovers">("installed");
  const [apps, setApps] = useState<InstalledAppInfo[]>([]);
  const [appIcons, setAppIcons] = useState<Record<string, string>>({});
  const [uwpApps, setUwpApps] = useState<UwpAppInfo[]>([]);
  const [uwpLoading, setUwpLoading] = useState(false);
  const [uninstallingPkg, setUninstallingPkg] = useState<string | null>(null);
  const [confirmUwpTarget, setConfirmUwpTarget] = useState<UwpAppInfo | null>(null);

  const [deepGroups, setDeepGroups] = useState<LeftoverGroup[]>([]);
  const [selectedLeftoverPaths, setSelectedLeftoverPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [leftoverLoading, setLeftoverLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"size" | "name" | "date">("size");
  const [notification, setNotification] = useState<string | null>(null);

  const [closingAppId, setClosingAppId] = useState<string | null>(null);
  const [huntingAppId, setHuntingAppId] = useState<string | null>(null);
  const [leftoverModalResult, setLeftoverModalResult] = useState<UninstallResult | null>(null);
  const [cleaningModalLeftovers, setCleaningModalLeftovers] = useState(false);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const loadApplications = async () => {
    setLoading(true);
    try {
      const res = await invoke<InstalledAppInfo[]>("get_installed_applications");
      setApps(res);

      // Extract real icons asynchronously for applications with icon paths
      const iconPaths = Array.from(
        new Set(
          res
            .map((a) => a.display_icon)
            .filter((p): p is string => Boolean(p && p.trim()))
        )
      );

      if (iconPaths.length > 0) {
        (async () => {
          for (let i = 0; i < iconPaths.length; i += 32) {
            const chunk = iconPaths.slice(i, i + 32);
            try {
              const result = await invoke<Array<{ path: string; dataUrl: string }>>("get_application_icons", { paths: chunk });
              if (result && result.length > 0) {
                setAppIcons((prev) => {
                  const next = { ...prev };
                  result.forEach((item) => {
                    next[item.path] = item.dataUrl;
                  });
                  return next;
                });
              }
            } catch (e) {
              console.warn("Failed to load chunk of app icons:", e);
            }
          }
        })();
      }
    } catch (e) {
      console.error("Failed to load applications:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadUwpApplications = async () => {
    setUwpLoading(true);
    try {
      const res = await invoke<UwpAppInfo[]>("get_uwp_applications");
      setUwpApps(res);
    } catch (e) {
      console.error("Failed to load UWP apps:", e);
    } finally {
      setUwpLoading(false);
    }
  };

  const handleUninstallUwp = async (pkg: UwpAppInfo) => {
    setUninstallingPkg(pkg.package_full_name);
    try {
      const success = await invoke<boolean>("uninstall_uwp_application", {
        packageFullName: pkg.package_full_name,
      });
      if (success) {
        setNotification(`Successfully uninstalled "${pkg.display_name}".`);
        setUwpApps((prev) => prev.filter((a) => a.package_full_name !== pkg.package_full_name));
        setTimeout(() => setNotification(null), 5000);
      } else {
        setNotification(`Failed to uninstall "${pkg.display_name}".`);
      }
    } catch (e) {
      console.error("UWP uninstallation failed:", e);
      setNotification(`Error uninstalling package: ${e}`);
    } finally {
      setUninstallingPkg(null);
      setConfirmUwpTarget(null);
    }
  };

  const reportLeftoverClean = (summary: LeftoverCleanSummary) => {
    if (summary.failed.length > 0) {
      const attempted =
        summary.failed.length + summary.removed_folders + summary.removed_registry_keys;
      toast.warning(t.cleanup.trashFailedTitle, `${summary.failed.length} / ${attempted}`);
    } else {
      toast.success(
        t.applications.cleanLeftovers,
        `${formatBytes(summary.freed_bytes)} ${t.cleanup.reclaimedSpace}`
      );
    }
  };

  const handleScanLeftovers = async () => {
    setLeftoverLoading(true);
    try {
      const res = await invoke<LeftoverGroup[]>("scan_deep_leftovers");
      setDeepGroups(res);
      const confident = new Set<string>();
      res.forEach((g) =>
        g.items.forEach((i) => {
          if (i.confidence.toLowerCase() === "high") confident.add(i.path_or_key);
        })
      );
      setSelectedLeftoverPaths(confident);
    } catch (e) {
      console.error("Failed to scan application leftovers:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setLeftoverLoading(false);
    }
  };

  const handleCleanSelectedLeftovers = async () => {
    if (selectedLeftoverPaths.size === 0) return;
    setCleaning(true);
    try {
      const paths = Array.from(selectedLeftoverPaths);
      const summary = await invoke<LeftoverCleanSummary>("clean_leftovers_safe", {
        paths,
        includeRegistry: true,
      });
      reportLeftoverClean(summary);
      await handleScanLeftovers();
    } catch (e) {
      console.error("Failed to clean leftovers:", e);
      toast.error(t.common.error, String(e));
    } finally {
      setCleaning(false);
    }
  };

  const handleCloseApp = async (app: InstalledAppInfo) => {
    setClosingAppId(app.id);
    try {
      const count = await invoke<number>("terminate_app_processes", { appId: app.id });
      if (count > 0) {
        toast.success(t.applications.closeApp, t.applications.appClosedSuccess);
        setApps((prev) =>
          prev.map((a) => (a.id === app.id ? { ...a, is_running: false } : a))
        );
      } else {
        toast.info(t.applications.closeApp, "No active processes found.");
      }
    } catch (e) {
      toast.error(t.common.error, String(e));
    } finally {
      setClosingAppId(null);
    }
  };

  const handleUninstallAndHunt = async (app: InstalledAppInfo) => {
    setHuntingAppId(app.id);
    try {
      const result = await invoke<UninstallResult>("uninstall_and_scan", {
        appId: app.id,
      });
      if (result.leftovers && result.leftovers.items.length > 0) {
        setLeftoverModalResult(result);
      } else {
        toast.success(t.applications.uninstall, result.message);
      }
      loadApplications();
    } catch (e) {
      toast.error(t.applications.uninstall, String(e));
    } finally {
      setHuntingAppId(null);
    }
  };

  const handleCleanModalLeftovers = async (group: LeftoverGroup) => {
    setCleaningModalLeftovers(true);
    try {
      const paths = group.items.map((i) => i.path_or_key);
      const summary = await invoke<LeftoverCleanSummary>("clean_leftovers_safe", {
        paths,
        includeRegistry: true,
      });
      reportLeftoverClean(summary);
      setLeftoverModalResult(null);
      handleScanLeftovers();
    } catch (e) {
      toast.error(t.common.error, String(e));
    } finally {
      setCleaningModalLeftovers(false);
    }
  };

  useEffect(() => {
    loadApplications();
  }, []);

  const handleUninstall = async (app: InstalledAppInfo) => {
    if (!app.uninstall_string) return;
    try {
      await invoke("launch_uninstaller", { appId: app.id });
    } catch (e) {
      toast.error(t.applications.uninstall, String(e));
    }
  };

  const handleReveal = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.warn("Failed to reveal item in Explorer:", err);
    }
  };

  const toggleLeftoverItem = (path: string) => {
    const next = new Set(selectedLeftoverPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedLeftoverPaths(next);
  };

  const toggleLeftoverGroup = (group: LeftoverGroup) => {
    const next = new Set(selectedLeftoverPaths);
    const allGroupSelected = group.items.every((i) => next.has(i.path_or_key));
    if (allGroupSelected) {
      group.items.forEach((i) => next.delete(i.path_or_key));
    } else {
      group.items.forEach((i) => next.add(i.path_or_key));
    }
    setSelectedLeftoverPaths(next);
  };

  const toggleSelectAllLeftovers = () => {
    const totalItems = deepGroups.reduce((acc, g) => acc + g.items.length, 0);
    if (selectedLeftoverPaths.size === totalItems) {
      setSelectedLeftoverPaths(new Set());
    } else {
      const all = new Set<string>();
      deepGroups.forEach((g) => g.items.forEach((i) => all.add(i.path_or_key)));
      setSelectedLeftoverPaths(all);
    }
  };

  const filteredApps = useMemo(() => {
    return apps
      .filter((a) => {
        const q = searchQuery.toLowerCase();
        return (
          a.name.toLowerCase().includes(q) ||
          (a.publisher && a.publisher.toLowerCase().includes(q)) ||
          (a.install_location && a.install_location.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (sortBy === "size") {
          return (b.estimated_size_bytes || 0) - (a.estimated_size_bytes || 0);
        }
        if (sortBy === "name") {
          return a.name.localeCompare(b.name);
        }
        if (sortBy === "date") {
          return (b.install_date || "").localeCompare(a.install_date || "");
        }
        return 0;
      });
  }, [apps, searchQuery, sortBy]);

  const totalAppSize = useMemo(() => apps.reduce((acc, a) => acc + (a.estimated_size_bytes || 0), 0), [apps]);
  const runningAppsCount = useMemo(() => apps.filter((a) => a.is_running).length, [apps]);

  const filteredUwpApps = useMemo(() => {
    return uwpApps
      .filter((a) => {
        const q = searchQuery.toLowerCase();
        return (
          a.display_name.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          (a.publisher && a.publisher.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (sortBy === "size") {
          return (b.estimated_size_bytes || 0) - (a.estimated_size_bytes || 0);
        }
        return a.display_name.localeCompare(b.display_name);
      });
  }, [uwpApps, searchQuery, sortBy]);

  const totalUwpSize = useMemo(
    () => uwpApps.reduce((acc, a) => acc + (a.estimated_size_bytes || 0), 0),
    [uwpApps]
  );

  const totalLeftoverBytes = useMemo(
    () => deepGroups.reduce((acc, g) => acc + g.total_size_bytes, 0),
    [deepGroups]
  );

  const totalFsBytes = useMemo(
    () =>
      deepGroups.reduce(
        (acc, g) =>
          acc +
          g.items
            .filter((i) => i.kind === "filesystem")
            .reduce((a, i) => a + i.size_bytes, 0),
        0
      ),
    [deepGroups]
  );

  const totalRegItems = useMemo(
    () =>
      deepGroups.reduce(
        (acc, g) => acc + g.items.filter((i) => i.kind === "registry").length,
        0
      ),
    [deepGroups]
  );

  const selectedLeftoverBytes = useMemo(() => {
    let bytes = 0;
    deepGroups.forEach((g) => {
      g.items.forEach((i) => {
        if (selectedLeftoverPaths.has(i.path_or_key)) {
          bytes += i.size_bytes;
        }
      });
    });
    return bytes;
  }, [deepGroups, selectedLeftoverPaths]);

  const totalLeftoverItemCount = useMemo(
    () => deepGroups.reduce((acc, g) => acc + g.items.length, 0),
    [deepGroups]
  );

  const handleRefresh = () => {
    if (activeTab === "installed") loadApplications();
    else if (activeTab === "uwp") loadUwpApplications();
    else handleScanLeftovers();
  };

  const refreshBusy =
    activeTab === "installed" ? loading : activeTab === "uwp" ? uwpLoading : leftoverLoading || cleaning;

  const handleTabChange = (tab: "installed" | "uwp" | "leftovers") => {
    setActiveTab(tab);
    if (tab === "uwp" && uwpApps.length === 0) loadUwpApplications();
    if (tab === "leftovers" && deepGroups.length === 0) handleScanLeftovers();
  };

  const searchBox = (
    <div className="relative flex-1 min-w-0">
      <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder={t.applications.searchPlaceholder}
        className={`${controlClass} w-full pl-8 pr-3 placeholder-[var(--text-muted)] select-text`}
      />
    </div>
  );

  const allLeftoversSelected =
    totalLeftoverItemCount > 0 && selectedLeftoverPaths.size === totalLeftoverItemCount;

  return (
    <Page className="select-none">
      <PageHeader
        icon={<Apps20Regular />}
        title={t.applications.title}
        description={t.applications.subtitle}
        actions={
          <WinUIButton
            variant="standard"
            onClick={handleRefresh}
            disabled={refreshBusy}
            icon={<ArrowClockwise20Regular className={`w-4 h-4 ${refreshBusy ? "animate-spin" : ""}`} />}
          >
            {t.common.refresh}
          </WinUIButton>
        }
      />

      <FilterTabs
        items={[
          { id: "installed" as const, label: t.applications.tabWin32, count: apps.length },
          {
            id: "uwp" as const,
            label: t.applications.tabUwp,
            count: uwpApps.length > 0 ? uwpApps.length : undefined,
          },
          {
            id: "leftovers" as const,
            label: t.applications.tabLeftovers,
            count: deepGroups.length > 0 ? deepGroups.length : undefined,
          },
        ]}
        value={activeTab}
        onChange={handleTabChange}
      />

      {/* Notice line (UWP uninstall result) */}
      {notification && (
        <Card className="py-2.5 flex items-center justify-between gap-3 animate-fadeIn">
          <div className="flex items-center gap-2 min-w-0">
            <Info20Regular className="w-4 h-4 shrink-0 text-[var(--accent-text)]" />
            <span className="text-sm text-[var(--text-primary)] truncate" title={notification}>
              {notification}
            </span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setNotification(null)}>
            {t.common.dismiss}
          </WinUIButton>
        </Card>
      )}

      {/* View 1: Installed applications */}
      {activeTab === "installed" && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label={t.applications.totalInstalled}
              value={apps.length}
              hint={t.applications.discoveredRegistry}
              icon={<Apps20Regular />}
            />
            <StatCard
              label={t.applications.estimatedUsage}
              value={formatBytes(totalAppSize)}
              hint={t.applications.declaredInstallers}
              icon={<HardDrive20Regular />}
            />
            <StatCard
              label={t.applications.runningBadge}
              value={runningAppsCount}
              hint={t.applications.activeProcesses}
              icon={<Pulse20Regular />}
              tone={runningAppsCount > 0 ? "success" : "neutral"}
            />
          </div>

          <div className="flex items-center gap-2">
            {searchBox}
            <div className="relative shrink-0">
              <ArrowSort20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                title={t.largeFiles.sortBy}
                className={`${controlClass} pl-8 pr-2 cursor-pointer`}
              >
                <option value="size" className="bg-[var(--bg-card)]">{t.applications.sortBySize}</option>
                <option value="name" className="bg-[var(--bg-card)]">{t.applications.sortByName}</option>
                <option value="date" className="bg-[var(--bg-card)]">{t.applications.sortByDate}</option>
              </select>
            </div>
          </div>

          {loading ? (
            <BusyCard title={t.common.scanning} />
          ) : filteredApps.length > 0 ? (
            <Card padded={false} className="overflow-hidden">
              <div className="divide-y divide-[var(--border-divider)]">
                {filteredApps.map((app) => {
                  const hunting = huntingAppId === app.id;
                  return (
                    <div
                      key={app.id}
                      className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <AppIcon
                          src={app.display_icon ? appIcons[app.display_icon] : null}
                          name={app.name}
                          fallback="AP"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-medium text-[var(--text-primary)] truncate" title={app.name}>
                              {app.name}
                            </span>
                            {app.display_version && (
                              <Badge className="font-ibm-mono shrink-0">v{app.display_version}</Badge>
                            )}
                            {app.is_running && (
                              <>
                                <Badge tone="success" className="shrink-0">
                                  <Pulse20Regular className="w-3 h-3" />
                                  {t.applications.runningBadge}
                                </Badge>
                                <span
                                  className="shrink-0"
                                  title={closingAppId === app.id ? t.applications.closingApp : t.applications.closeApp}
                                >
                                  <WinUIButton
                                    variant="subtle"
                                    size="sm"
                                    className="w-7 !px-0"
                                    aria-label={t.applications.closeApp}
                                    onClick={() => handleCloseApp(app)}
                                    disabled={closingAppId === app.id}
                                    icon={
                                      closingAppId === app.id ? (
                                        <ArrowClockwise20Regular className="w-4 h-4 animate-spin text-[var(--text-secondary)]" />
                                      ) : (
                                        <DismissCircle20Regular className="w-4 h-4 text-[var(--text-secondary)]" />
                                      )
                                    }
                                  />
                                </span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-3 min-w-0 mt-0.5 text-xs">
                            {app.publisher && (
                              <span className="text-[var(--text-secondary)] truncate shrink-0 max-w-[40%]" title={app.publisher}>
                                {app.publisher}
                              </span>
                            )}
                            {app.install_location && (
                              <span
                                className="font-code text-xs text-[var(--text-muted)] truncate min-w-0"
                                title={app.install_location}
                              >
                                {app.install_location}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 justify-between md:justify-end">
                        <span className="w-20 text-right text-sm font-ibm-mono tabular-nums text-[var(--text-primary)]">
                          {app.estimated_size_bytes ? formatBytes(app.estimated_size_bytes) : "—"}
                        </span>
                        {app.uninstall_string && (
                          <div className="flex items-center gap-1">
                            <WinUIButton
                              variant="standard"
                              size="sm"
                              onClick={() => handleUninstallAndHunt(app)}
                              disabled={hunting}
                              title={t.applications.uninstallAndHuntDesc}
                              icon={
                                hunting ? (
                                  <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Flash20Regular className="w-4 h-4 text-[var(--accent-text)]" />
                                )
                              }
                            >
                              {hunting ? t.applications.uninstalling : t.applications.uninstallAndHunt}
                            </WinUIButton>
                            <WinUIButton
                              variant="subtle"
                              size="sm"
                              onClick={() => handleUninstall(app)}
                              title={t.applications.confirmWin32Title}
                              icon={<Open20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                            >
                              {t.applications.uninstall}
                            </WinUIButton>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : (
            <EmptyState
              icon={<Apps20Regular />}
              title={t.applications.noAppsFound}
              description={t.applications.noAppsDesc}
            />
          )}
        </>
      )}

      {/* View 2: Windows Store & bloatware (UWP) */}
      {activeTab === "uwp" && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              label={t.applications.storePackagesFound}
              value={uwpApps.length}
              hint={t.applications.removableUwp}
              icon={<Apps20Regular />}
            />
            <StatCard
              label={t.applications.estimatedFootprint}
              value={formatBytes(totalUwpSize)}
              hint={t.applications.windowsAppsDirs}
              icon={<HardDrive20Regular />}
            />
            <StatCard
              label={t.applications.safeUninstallNotice}
              value={<span className="font-sans">{t.applications.allUsers}</span>}
              hint={t.applications.powerShellElevation}
              icon={<Layer20Regular />}
            />
          </div>

          <div className="flex items-center gap-2">{searchBox}</div>

          {uwpLoading ? (
            <BusyCard title={t.common.scanning} />
          ) : filteredUwpApps.length > 0 ? (
            <Card padded={false} className="overflow-hidden">
              <div className="divide-y divide-[var(--border-divider)]">
                {filteredUwpApps.map((pkg) => (
                  <div
                    key={pkg.package_full_name}
                    className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <AppIcon src={pkg.icon_data_url} name={pkg.display_name} fallback="WP" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-[var(--text-primary)] truncate" title={pkg.display_name}>
                            {pkg.display_name}
                          </span>
                          {pkg.version && <Badge className="font-ibm-mono shrink-0">v{pkg.version}</Badge>}
                          <Badge className="font-ibm-mono shrink-0">UWP</Badge>
                        </div>
                        <div className="flex items-center gap-3 min-w-0 mt-0.5 text-xs">
                          {pkg.publisher && (
                            <span className="text-[var(--text-secondary)] truncate shrink-0 max-w-[40%]" title={pkg.publisher}>
                              {pkg.publisher}
                            </span>
                          )}
                          {pkg.install_location && (
                            <span
                              className="font-code text-xs text-[var(--text-muted)] truncate min-w-0"
                              title={pkg.install_location}
                            >
                              {pkg.install_location}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 justify-between md:justify-end">
                      <span className="w-20 text-right text-sm font-ibm-mono tabular-nums text-[var(--text-primary)]">
                        {pkg.estimated_size_bytes ? formatBytes(pkg.estimated_size_bytes) : ""}
                      </span>
                      <WinUIButton
                        variant="subtle"
                        size="sm"
                        onClick={() => setConfirmUwpTarget(pkg)}
                        icon={<Delete20Regular className="w-4 h-4 text-[var(--danger)]" />}
                      >
                        {t.applications.uninstallBloatware}
                      </WinUIButton>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <EmptyState
              icon={<Apps20Regular />}
              title={t.applications.noAppsFound}
              description={t.applications.noAppsDesc}
            />
          )}
        </>
      )}

      {/* View 3: Leftover hunter */}
      {activeTab === "leftovers" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.applications.tabLeftovers}
              value={deepGroups.length}
              hint={t.applications.leftoverCount}
              icon={<FolderDismiss20Regular />}
              tone={deepGroups.length > 0 ? "warning" : "neutral"}
            />
            <StatCard
              label={t.applications.filesystemRemnants}
              value={formatBytes(totalFsBytes)}
              hint="AppData & ProgramData"
              icon={<Folder20Regular />}
            />
            <StatCard
              label={t.applications.registryHives}
              value={totalRegItems}
              hint="HKCU & HKLM Software"
              icon={<DocumentBulletList20Regular />}
            />
            <StatCard
              label={t.applications.leftoverSize}
              value={formatBytes(totalLeftoverBytes)}
              hint={t.virtualization.reclaimable}
              icon={<Sparkle20Regular />}
              tone={totalLeftoverBytes > 0 ? "success" : "neutral"}
            />
          </div>

          {leftoverLoading ? (
            <BusyCard title={t.common.scanning} subtitle={t.applications.tabLeftovers} />
          ) : deepGroups.length === 0 ? (
            <EmptyState
              icon={<CheckmarkCircle20Regular />}
              title={t.applications.noLeftoversFound}
              description={t.applications.noLeftoversDesc}
              action={
                <WinUIButton
                  variant="primary"
                  size="lg"
                  onClick={handleScanLeftovers}
                  icon={<Search20Regular className="w-4 h-4" />}
                >
                  {t.common.rescan}
                </WinUIButton>
              }
            />
          ) : (
            <Card padded={false} className="overflow-hidden">
              {/* Header: select all + selection count */}
              <div className="px-4 py-2 flex items-center justify-between gap-3 border-b border-[var(--border-divider)] text-xs text-[var(--text-secondary)]">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allLeftoversSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedLeftoverPaths.size > 0 && !allLeftoversSelected;
                    }}
                    onChange={toggleSelectAllLeftovers}
                    className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                  />
                  <span>{allLeftoversSelected ? t.cleanup.clear : t.cleanup.selectAll}</span>
                </label>
                <span className="text-[var(--text-muted)] tabular-nums">
                  {selectedLeftoverPaths.size} / {totalLeftoverItemCount} {t.cleanup.itemsSelected} (
                  {formatBytes(selectedLeftoverBytes)})
                </span>
              </div>

              <div className="divide-y divide-[var(--border-divider)]">
                {deepGroups.map((group) => {
                  const allSelected = group.items.every((i) => selectedLeftoverPaths.has(i.path_or_key));
                  const someSelected = group.items.some((i) => selectedLeftoverPaths.has(i.path_or_key));
                  const conf = group.overall_confidence.toLowerCase();

                  return (
                    <div key={group.id}>
                      {/* Group header */}
                      <div
                        onClick={() => toggleLeftoverGroup(group)}
                        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-[var(--fill-subtle)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected;
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleLeftoverGroup(group)}
                          className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                        />
                        <span className="w-8 h-8 shrink-0 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)]">
                          <FolderDismiss20Regular className="w-4 h-4" />
                        </span>
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{group.app_name}</span>
                          <Badge tone={confidenceTone(conf)} className="shrink-0">
                            {conf === "high"
                              ? t.applications.confidenceHigh
                              : conf === "medium"
                              ? t.applications.confidenceMedium
                              : t.applications.confidenceLow}
                          </Badge>
                          <span className="text-xs text-[var(--text-muted)] shrink-0">
                            {group.items.length} {t.applications.itemsCount}
                          </span>
                        </div>
                        <span className="text-sm font-ibm-mono tabular-nums text-[var(--text-primary)] shrink-0">
                          {formatBytes(group.total_size_bytes)}
                        </span>
                      </div>

                      {/* Items */}
                      <div className="divide-y divide-[var(--border-divider)] border-t border-[var(--border-divider)]">
                        {group.items.map((item) => {
                          const isSelected = selectedLeftoverPaths.has(item.path_or_key);
                          return (
                            <div
                              key={item.id}
                              onClick={() => toggleLeftoverItem(item.path_or_key)}
                              className={`pl-11 pr-4 py-2 flex items-center gap-3 cursor-pointer transition-colors ${
                                isSelected ? "bg-[var(--fill-subtle)]" : "hover:bg-[var(--fill-subtle)]"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleLeftoverItem(item.path_or_key)}
                                className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer"
                              />
                              {item.kind === "filesystem" ? (
                                <Folder20Regular className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
                              ) : (
                                <DocumentBulletList20Regular className="w-4 h-4 shrink-0 text-[var(--text-secondary)]" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div
                                  className="font-code text-xs text-[var(--text-primary)] truncate select-all"
                                  title={item.path_or_key}
                                >
                                  {item.path_or_key}
                                </div>
                                <div className="text-xs text-[var(--text-muted)] truncate">
                                  {item.description} ({item.item_count} {t.applications.itemsCount})
                                </div>
                              </div>
                              <span className="text-xs font-ibm-mono tabular-nums text-[var(--text-secondary)] shrink-0">
                                {formatBytes(item.size_bytes)}
                              </span>
                              <span className="w-8 shrink-0 flex justify-end" title={item.kind === "filesystem" ? t.common.openInExplorer : undefined}>
                                {item.kind === "filesystem" && (
                                  <WinUIButton
                                    variant="subtle"
                                    size="sm"
                                    className="w-8 !px-0"
                                    aria-label={t.common.openInExplorer}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleReveal(item.path_or_key);
                                    }}
                                    icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                                  />
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {deepGroups.length > 0 && selectedLeftoverPaths.size > 0 && (
            <ActionBar
              summary={
                <span className="font-semibold text-[var(--text-primary)]">
                  {selectedLeftoverPaths.size} / {totalLeftoverItemCount} {t.cleanup.itemsSelected} ·{" "}
                  <span className="font-ibm-mono">{formatBytes(selectedLeftoverBytes)}</span>
                </span>
              }
            >
              <WinUIButton variant="standard" onClick={() => setSelectedLeftoverPaths(new Set())} disabled={cleaning}>
                {t.cleanup.clear}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleCleanSelectedLeftovers}
                disabled={cleaning}
                icon={
                  cleaning ? (
                    <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                  ) : (
                    <Delete20Regular className="w-4 h-4" />
                  )
                }
              >
                {cleaning
                  ? t.applications.cleaningLeftovers
                  : `${t.applications.cleanLeftovers} (${formatBytes(selectedLeftoverBytes)})`}
              </WinUIButton>
            </ActionBar>
          )}
        </>
      )}

      {/* Confirmation modal for UWP bloatware removal */}
      {confirmUwpTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t.applications.confirmUwpTitle}</h3>
                <p className="text-sm text-[var(--text-secondary)]">{t.applications.confirmUwpDesc}</p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] px-3 py-2 space-y-0.5">
              <div className="text-sm font-medium text-[var(--text-primary)]">{confirmUwpTarget.display_name}</div>
              <div className="font-code text-xs text-[var(--text-muted)] truncate select-all" title={confirmUwpTarget.package_full_name}>
                {confirmUwpTarget.package_full_name}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <WinUIButton
                variant="standard"
                onClick={() => setConfirmUwpTarget(null)}
                disabled={uninstallingPkg !== null}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={() => handleUninstallUwp(confirmUwpTarget)}
                disabled={uninstallingPkg === confirmUwpTarget.package_full_name}
                icon={
                  uninstallingPkg === confirmUwpTarget.package_full_name ? (
                    <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                  ) : undefined
                }
              >
                {uninstallingPkg === confirmUwpTarget.package_full_name ? t.common.deleting : t.common.uninstall}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}

      {/* Post-uninstall leftovers discovered modal */}
      {leftoverModalResult && leftoverModalResult.leftovers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--accent-text)] shrink-0">
                <Sparkle20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">
                  {t.applications.leftoversFoundModalTitle}
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  {t.applications.leftoversFoundModalDesc} ({leftoverModalResult.app_name})
                </p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] max-h-60 overflow-y-auto divide-y divide-[var(--border-divider)]">
              {leftoverModalResult.leftovers.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="font-code text-xs truncate text-[var(--text-secondary)]" title={item.path_or_key}>
                    {item.path_or_key}
                  </span>
                  <span className="shrink-0 text-xs font-ibm-mono text-[var(--text-primary)]">
                    {formatBytes(item.size_bytes)}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="text-sm text-[var(--text-secondary)]">
                {t.applications.leftoverSize}:{" "}
                <span className="font-ibm-mono font-semibold text-[var(--text-primary)]">
                  {formatBytes(leftoverModalResult.leftovers.total_size_bytes)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <WinUIButton
                  variant="standard"
                  onClick={() => setLeftoverModalResult(null)}
                  disabled={cleaningModalLeftovers}
                >
                  {t.common.dismiss}
                </WinUIButton>
                <WinUIButton
                  variant="primary"
                  onClick={() => handleCleanModalLeftovers(leftoverModalResult.leftovers!)}
                  disabled={cleaningModalLeftovers}
                  icon={
                    cleaningModalLeftovers ? <ArrowClockwise20Regular className="w-4 h-4 animate-spin" /> : undefined
                  }
                >
                  {cleaningModalLeftovers ? t.applications.cleaningLeftovers : t.applications.cleanNow}
                </WinUIButton>
              </div>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default ApplicationsPage;
