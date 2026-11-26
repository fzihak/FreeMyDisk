import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { toast } from "@/stores/toast-store";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import {
  Apps24Filled,
  Apps20Regular,
  ArrowClockwise20Regular,
  Search20Regular,
  Open20Regular,
  Delete20Regular,
  FolderDismiss20Regular,
  Pulse20Regular,
  CheckmarkCircle20Filled,
  HardDrive20Regular,
  ArrowSort20Regular,
  Layer20Regular,
  Checkmark16Filled,
  FolderOpen16Regular,
  Flash20Filled,
  DismissCircle20Filled,
  Sparkle20Filled,
  DocumentBulletList20Regular,
  Folder20Regular,
} from "@fluentui/react-icons";

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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <Apps24Filled className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t.applications.title}</h1>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.applications.subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Tab switcher - WinUI 3 Segmented Control (own row so all tabs fit on one line) */}
      <div className="flex">
        <div className="flex flex-nowrap items-center gap-1 bg-black/20 p-0.5 rounded-[4px] border border-[var(--border-card)] max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-3 py-1 rounded-[3px] text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
              activeTab === "installed"
                ? "bg-[#0078d4] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t.applications.tabWin32} ({apps.length})
          </button>
          <button
            onClick={() => {
              setActiveTab("uwp");
              if (uwpApps.length === 0) loadUwpApplications();
            }}
            className={`px-3 py-1 rounded-[3px] text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
              activeTab === "uwp"
                ? "bg-purple-600 text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t.applications.tabUwp} {uwpApps.length > 0 && `(${uwpApps.length})`}
          </button>
          <button
            onClick={() => {
              setActiveTab("leftovers");
              if (deepGroups.length === 0) handleScanLeftovers();
            }}
            className={`px-3 py-1 rounded-[3px] text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
              activeTab === "leftovers"
                ? "bg-[#0078d4] text-white shadow-xs"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t.applications.tabLeftovers} {deepGroups.length > 0 && `(${deepGroups.length})`}
          </button>
        </div>
      </div>

      {/* Notification Banner */}
      {notification && (
        <div className="p-3 bg-[#0078d4]/10 border border-[#0078d4]/30 rounded-[4px] flex items-center justify-between text-xs text-[#0078d4] animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckmarkCircle20Filled className="w-4 h-4 text-[#0078d4] shrink-0" />
            <span>{notification}</span>
          </div>
          <button onClick={() => setNotification(null)} className="text-[#0078d4] hover:underline cursor-pointer">
            {t.common.dismiss}
          </button>
        </div>
      )}

      {/* Tab 1: Installed Applications */}
      {activeTab === "installed" && (
        <div className="space-y-4">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-ibm-mono">
            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.totalInstalled}</span>
                <Apps20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
              </div>
              <div className="text-xl font-bold text-[var(--text-primary)] tabular-nums">{apps.length}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.discoveredRegistry}</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.estimatedUsage}</span>
                <HardDrive20Regular className="w-3.5 h-3.5 text-cyan-400" />
              </div>
              <div className="text-xl font-bold text-cyan-400 tabular-nums">{formatBytes(totalAppSize)}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.declaredInstallers}</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.runningBadge}</span>
                <Pulse20Regular className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="text-xl font-bold text-emerald-400 tabular-nums">{runningAppsCount}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.activeProcesses}</div>
            </WinUICard>
          </div>

          {/* Search & Sort Toolbar */}
          <WinUICard className="p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative flex-1 w-full">
              <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.applications.searchPlaceholder}
                className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#0078d4] font-ibm-mono transition-colors"
              />
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] font-sans">
                <ArrowSort20Regular className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                <span>{t.largeFiles.sortBy}</span>
              </div>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-black/20 border border-[var(--border-card)] text-xs text-[var(--text-primary)] rounded-[4px] px-2 py-1 focus:outline-none focus:border-[#0078d4] font-sans cursor-pointer"
              >
                <option value="size" className="bg-[#202020] text-[var(--text-primary)]">{t.applications.sortBySize}</option>
                <option value="name" className="bg-[#202020] text-[var(--text-primary)]">{t.applications.sortByName}</option>
                <option value="date" className="bg-[#202020] text-[var(--text-primary)]">{t.applications.sortByDate}</option>
              </select>

              <WinUIButton
                variant="subtle"
                onClick={loadApplications}
                disabled={loading}
                className="p-1.5"
                title={t.common.rescan}
              >
                <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              </WinUIButton>
            </div>
          </WinUICard>

          {/* Applications List */}
          {loading ? (
            <WinUICard className="p-12 text-center space-y-2">
              <ArrowClockwise20Regular className="w-6 h-6 animate-spin text-[#0078d4] mx-auto" />
              <p className="text-xs font-semibold text-[var(--text-primary)]">{t.common.scanning}</p>
            </WinUICard>
          ) : filteredApps.length > 0 ? (
            <WinUICard className="overflow-hidden">
              <div className="divide-y divide-[var(--border-divider)]">
                {filteredApps.map((app) => (
                  <div
                    key={app.id}
                    className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {/* Application Icon with Fallback */}
                      {app.display_icon && appIcons[app.display_icon] ? (
                        <img
                          src={appIcons[app.display_icon]}
                          alt={app.name}
                          className="w-9 h-9 object-contain rounded-[4px] p-1 bg-black/20 border border-[var(--border-card)] shrink-0"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-[4px] bg-[#0078d4]/10 border border-[#0078d4]/20 flex items-center justify-center font-bold text-xs text-[#0078d4] shrink-0 font-ibm-mono">
                          {app.name.trim().slice(0, 2).toUpperCase() || "AP"}
                        </div>
                      )}

                      <div className="space-y-0.5 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-[var(--text-primary)] text-xs truncate">
                            {app.name}
                          </span>
                          {app.display_version && (
                            <span className="text-xs px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-muted)] font-ibm-mono">
                              v{app.display_version}
                            </span>
                          )}
                          {app.is_running && (
                            <div className="flex items-center gap-1.5">
                              <span className="flex items-center gap-1 text-xs px-1.5 py-0.2 rounded-[3px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-ibm-mono">
                                <Pulse20Regular className="w-3 h-3 text-emerald-400 animate-pulse" /> {t.applications.runningBadge}
                              </span>
                              <WinUIButton
                                variant="subtle"
                                size="sm"
                                onClick={() => handleCloseApp(app)}
                                disabled={closingAppId === app.id}
                                className="text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 h-6 px-1.5 text-xs"
                                title={t.applications.closeApp}
                              >
                                <DismissCircle20Filled className="w-3 h-3 text-rose-400" />
                                <span>{closingAppId === app.id ? t.applications.closingApp : t.applications.closeApp}</span>
                              </WinUIButton>
                            </div>
                          )}
                        </div>

                        <div className="text-xs text-[var(--text-secondary)] flex items-center gap-3 truncate">
                          {app.publisher && <span>{app.publisher}</span>}
                          {app.install_location && (
                            <span className="text-[var(--text-muted)] truncate max-w-md font-ibm-mono text-xs">
                              {app.install_location}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 justify-between sm:justify-end font-ibm-mono">
                      <div className="text-right text-xs font-bold text-[var(--text-primary)] tabular-nums mr-2">
                        {app.estimated_size_bytes ? formatBytes(app.estimated_size_bytes) : "—"}
                      </div>
                      {app.uninstall_string && (
                        <>
                          <WinUIButton
                            variant="primary"
                            onClick={() => handleUninstallAndHunt(app)}
                            disabled={huntingAppId === app.id}
                            className="flex items-center gap-1.5 text-xs bg-[#0078d4] hover:bg-[#187bd1]"
                            title={t.applications.uninstallAndHuntDesc}
                          >
                            {huntingAppId === app.id ? (
                              <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Flash20Filled className="w-3.5 h-3.5" />
                            )}
                            <span>{huntingAppId === app.id ? t.applications.uninstalling : t.applications.uninstallAndHunt}</span>
                          </WinUIButton>

                          <WinUIButton
                            variant="standard"
                            onClick={() => handleUninstall(app)}
                            className="flex items-center gap-1 text-xs"
                            title={t.applications.confirmWin32Title}
                          >
                            <Open20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
                            <span>{t.applications.uninstall}</span>
                          </WinUIButton>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </WinUICard>
          ) : (
            <WinUICard className="p-12 text-center space-y-2">
              <Apps24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
              <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.applications.noAppsFound}</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                {t.applications.noAppsDesc}
              </p>
            </WinUICard>
          )}
        </div>
      )}

      {/* Tab 2: Windows Store & Bloatware (UWP) */}
      {activeTab === "uwp" && (
        <div className="space-y-4">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-ibm-mono">
            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.storePackagesFound}</span>
                <Apps20Regular className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="text-xl font-bold text-[var(--text-primary)] tabular-nums">{uwpApps.length}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.removableUwp}</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.estimatedFootprint}</span>
                <HardDrive20Regular className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="text-xl font-bold text-purple-400 tabular-nums">{formatBytes(totalUwpSize)}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.windowsAppsDirs}</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.safeUninstallNotice}</span>
                <Layer20Regular className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="text-xl font-bold text-emerald-400 font-sans">{t.applications.allUsers}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.powerShellElevation}</div>
            </WinUICard>
          </div>

          {/* Search Toolbar */}
          <WinUICard className="p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative flex-1 w-full">
              <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.applications.searchPlaceholder}
                className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-purple-500 font-ibm-mono transition-colors"
              />
            </div>

            <WinUIButton
              variant="subtle"
              onClick={loadUwpApplications}
              disabled={uwpLoading}
              className="p-1.5 shrink-0"
              title={t.common.rescan}
            >
              <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${uwpLoading ? "animate-spin" : ""}`} />
            </WinUIButton>
          </WinUICard>

          {/* UWP List */}
          {uwpLoading ? (
            <WinUICard className="p-12 text-center space-y-2">
              <ArrowClockwise20Regular className="w-6 h-6 animate-spin text-purple-400 mx-auto" />
              <p className="text-xs font-semibold text-[var(--text-primary)]">{t.common.scanning}</p>
            </WinUICard>
          ) : filteredUwpApps.length > 0 ? (
            <WinUICard className="overflow-hidden">
              <div className="divide-y divide-[var(--border-divider)]">
                {filteredUwpApps.map((pkg) => (
                  <div
                    key={pkg.package_full_name}
                    className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {pkg.icon_data_url ? (
                        <img
                          src={pkg.icon_data_url}
                          alt={pkg.display_name}
                          className="w-9 h-9 object-contain rounded-[4px] shrink-0 bg-black/20 p-1 border border-purple-500/20"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-[4px] bg-purple-500/10 border border-purple-500/20 flex items-center justify-center font-bold text-xs text-purple-400 shrink-0 font-ibm-mono">
                          {pkg.display_name.trim().slice(0, 2).toUpperCase() || "WP"}
                        </div>
                      )}

                      <div className="space-y-0.5 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-[var(--text-primary)] text-xs truncate">
                            {pkg.display_name}
                          </span>
                          {pkg.version && (
                            <span className="text-xs px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-muted)] font-ibm-mono">
                              v{pkg.version}
                            </span>
                          )}
                          <span className="text-xs px-1.5 py-0.2 rounded-[3px] bg-purple-500/10 text-purple-400 border border-purple-500/20 font-ibm-mono">
                            UWP
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] flex-wrap">
                          {pkg.publisher && <span>{pkg.publisher}</span>}
                          {pkg.install_location && (
                            <span className="font-ibm-mono text-xs text-[var(--text-muted)] truncate max-w-xs">
                              {pkg.install_location}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 self-end sm:self-auto shrink-0 font-ibm-mono">
                      {pkg.estimated_size_bytes ? (
                        <span className="text-xs font-bold text-[var(--text-primary)] tabular-nums">
                          {formatBytes(pkg.estimated_size_bytes)}
                        </span>
                      ) : null}

                      <WinUIButton
                        variant="danger"
                        onClick={() => setConfirmUwpTarget(pkg)}
                        className="flex items-center gap-1 text-xs"
                      >
                        <Delete20Regular className="w-3.5 h-3.5" />
                        <span>{t.applications.uninstallBloatware}</span>
                      </WinUIButton>
                    </div>
                  </div>
                ))}
              </div>
            </WinUICard>
          ) : (
            <WinUICard className="p-12 text-center space-y-2">
              <Apps24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
              <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.applications.noAppsFound}</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                {t.applications.noAppsDesc}
              </p>
            </WinUICard>
          )}
        </div>
      )}

      {/* Tab 3: Leftovers Hunter */}
      {activeTab === "leftovers" && (
        <div className="space-y-4">
          {/* Quick Stats Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 font-ibm-mono">
            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.tabLeftovers}</span>
                <FolderDismiss20Regular className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="text-xl font-bold text-amber-400 tabular-nums">{deepGroups.length}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.applications.leftoverCount}</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.filesystemRemnants}</span>
                <Folder20Regular className="w-3.5 h-3.5 text-blue-400" />
              </div>
              <div className="text-xl font-bold text-blue-400 tabular-nums">{formatBytes(totalFsBytes)}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">AppData & ProgramData</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.registryHives}</span>
                <DocumentBulletList20Regular className="w-3.5 h-3.5 text-purple-400" />
              </div>
              <div className="text-xl font-bold text-purple-400 tabular-nums">{totalRegItems}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">HKCU & HKLM Software</div>
            </WinUICard>

            <WinUICard className="p-3.5">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
                <span className="font-medium text-xs">{t.applications.leftoverSize}</span>
                <Sparkle20Filled className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div className="text-xl font-bold text-emerald-400 tabular-nums">{formatBytes(totalLeftoverBytes)}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.virtualization.reclaimable}</div>
            </WinUICard>
          </div>

          {/* Action Toolbar */}
          <WinUICard className="p-3 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <FolderDismiss20Regular className="w-4 h-4 text-amber-400" />
                {t.applications.tabLeftovers}
              </h2>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {t.applications.subtitle}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <WinUIButton
                variant="subtle"
                onClick={handleScanLeftovers}
                disabled={leftoverLoading}
                className="flex items-center gap-1.5"
              >
                <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${leftoverLoading ? "animate-spin" : ""}`} />
                <span>{t.common.rescan}</span>
              </WinUIButton>
              {deepGroups.length > 0 && selectedLeftoverPaths.size > 0 && (
                <WinUIButton
                  variant="danger"
                  onClick={handleCleanSelectedLeftovers}
                  disabled={cleaning}
                  className="flex items-center gap-1.5 font-ibm-mono"
                >
                  <Delete20Regular className="w-3.5 h-3.5" />
                  <span>
                    {cleaning
                      ? t.applications.cleaningLeftovers
                      : `${t.applications.cleanLeftovers} (${formatBytes(selectedLeftoverBytes)})`}
                  </span>
                </WinUIButton>
              )}
            </div>
          </WinUICard>

          {leftoverLoading ? (
            <WinUICard className="p-12 text-center space-y-2">
              <ArrowClockwise20Regular className="w-6 h-6 animate-spin text-amber-400 mx-auto" />
              <p className="text-xs font-semibold text-[var(--text-primary)]">{t.common.scanning}</p>
            </WinUICard>
          ) : deepGroups.length === 0 ? (
            <WinUICard className="p-12 text-center space-y-2">
              <CheckmarkCircle20Filled className="w-10 h-10 text-emerald-400 mx-auto" />
              <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.applications.noLeftoversFound}</h3>
              <p className="text-xs text-[var(--text-secondary)]">
                {t.applications.noLeftoversDesc}
              </p>
            </WinUICard>
          ) : (
            <WinUICard className="overflow-hidden">
              <div className="px-4 py-2.5 bg-black/20 border-b border-[var(--border-divider)] flex items-center justify-between text-xs font-ibm-mono">
                <button
                  onClick={toggleSelectAllLeftovers}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer font-medium font-sans"
                >
                  {selectedLeftoverPaths.size === totalLeftoverItemCount ? t.cleanup.clear : t.cleanup.selectAll}
                </button>
                <span className="text-[var(--text-muted)] text-xs tabular-nums">
                  {selectedLeftoverPaths.size} / {totalLeftoverItemCount} {t.cleanup.itemsSelected} ({formatBytes(selectedLeftoverBytes)})
                </span>
              </div>

              <div className="divide-y divide-[var(--border-divider)]">
                {deepGroups.map((group) => {
                  const allSelected = group.items.every((i) => selectedLeftoverPaths.has(i.path_or_key));
                  const someSelected = group.items.some((i) => selectedLeftoverPaths.has(i.path_or_key));

                  return (
                    <div key={group.id} className="p-4 space-y-3 hover:bg-white/[0.015] transition-colors">
                      {/* Group Header */}
                      <div className="flex items-center justify-between gap-3">
                        <div
                          onClick={() => toggleLeftoverGroup(group)}
                          className="flex items-center gap-3 cursor-pointer flex-1 min-w-0"
                        >
                          <div
                            className={`w-4 h-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors ${
                              allSelected
                                ? "bg-[#0078d4] border-[#0078d4] text-white"
                                : someSelected
                                ? "bg-[#0078d4]/40 border-[#0078d4] text-white"
                                : "border-[var(--border-subtle)] bg-black/20"
                            }`}
                          >
                            {allSelected && <Checkmark16Filled className="w-3 h-3 text-white" />}
                            {someSelected && !allSelected && <div className="w-2 h-0.5 bg-white rounded-full" />}
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-[var(--text-primary)]">{group.app_name}</span>
                            <span
                              className={`text-xs font-ibm-mono px-2 py-0.5 rounded border font-medium ${
                                group.overall_confidence.toLowerCase() === "high"
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : group.overall_confidence.toLowerCase() === "medium"
                                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                  : "bg-slate-500/10 text-slate-400 border-slate-500/20"
                              }`}
                            >
                              {group.overall_confidence.toLowerCase() === "high"
                                ? t.applications.confidenceHigh
                                : group.overall_confidence.toLowerCase() === "medium"
                                ? t.applications.confidenceMedium
                                : t.applications.confidenceLow}
                            </span>
                          </div>
                        </div>

                        <div className="text-right font-ibm-mono text-xs font-bold text-emerald-400 tabular-nums">
                          {formatBytes(group.total_size_bytes)}
                        </div>
                      </div>

                      {/* Items List */}
                      <div className="pl-7 space-y-1.5 font-ibm-mono text-xs">
                        {group.items.map((item) => {
                          const isSelected = selectedLeftoverPaths.has(item.path_or_key);

                          return (
                            <div
                              key={item.id}
                              onClick={() => toggleLeftoverItem(item.path_or_key)}
                              className="p-2 rounded bg-white/[0.02] border border-[var(--border-card)] flex items-center justify-between gap-3 hover:bg-white/[0.04] transition-colors cursor-pointer"
                            >
                              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                <div
                                  className={`w-3.5 h-3.5 rounded-[2px] border flex items-center justify-center shrink-0 ${
                                    isSelected
                                      ? "bg-[#0078d4] border-[#0078d4] text-white"
                                      : "border-[var(--border-subtle)] bg-black/20"
                                  }`}
                                >
                                  {isSelected && <Checkmark16Filled className="w-2.5 h-2.5 text-white" />}
                                </div>

                                {item.kind === "filesystem" ? (
                                  <Folder20Regular className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                                ) : (
                                  <DocumentBulletList20Regular className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                )}

                                <div className="space-y-0.5 flex-1 min-w-0">
                                  <div className="text-xs text-[var(--text-secondary)] truncate select-all">
                                    {item.path_or_key}
                                  </div>
                                  <div className="text-xs text-[var(--text-muted)] font-sans">
                                    {item.description} ({item.item_count} {t.applications.itemsCount})
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-xs font-bold text-[var(--text-primary)] tabular-nums">
                                  {formatBytes(item.size_bytes)}
                                </span>
                                {item.kind === "filesystem" && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleReveal(item.path_or_key);
                                    }}
                                    title={t.common.openInExplorer}
                                    className="hover:text-[var(--text-primary)] text-[var(--text-secondary)] transition-colors p-1"
                                  >
                                    <FolderOpen16Regular className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </WinUICard>
          )}
        </div>
      )}

      {/* Confirmation Modal for UWP Bloatware Removal */}
      {confirmUwpTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <WinUICard className="max-w-md w-full p-5 space-y-3 shadow-2xl animate-fadeIn">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-[4px] bg-rose-500/10 border border-rose-500/20 text-rose-400 shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.applications.confirmUwpTitle}</h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t.applications.confirmUwpDesc}</p>
              </div>
            </div>

            <div className="p-2.5 bg-black/30 rounded-[4px] border border-[var(--border-card)] font-ibm-mono text-xs space-y-0.5">
              <div className="text-[var(--text-primary)] font-semibold">{confirmUwpTarget.display_name}</div>
              <div className="text-[var(--text-muted)] text-xs truncate select-all">{confirmUwpTarget.package_full_name}</div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton
                variant="subtle"
                onClick={() => setConfirmUwpTarget(null)}
                disabled={uninstallingPkg !== null}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={() => handleUninstallUwp(confirmUwpTarget)}
                disabled={uninstallingPkg === confirmUwpTarget.package_full_name}
              >
                {uninstallingPkg === confirmUwpTarget.package_full_name ? t.common.deleting : t.common.uninstall}
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}

      {/* Post-Uninstall Leftovers Discovered Modal */}
      {leftoverModalResult && leftoverModalResult.leftovers && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <WinUICard className="max-w-lg w-full p-6 space-y-4 shadow-2xl animate-fadeIn">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-[4px] bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 shrink-0">
                <Sparkle20Filled className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t.applications.leftoversFoundModalTitle}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {t.applications.leftoversFoundModalDesc} ({leftoverModalResult.app_name})
                </p>
              </div>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1.5 p-3 bg-black/30 rounded-[4px] border border-[var(--border-card)] font-ibm-mono text-xs">
              {leftoverModalResult.leftovers.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 p-1.5 bg-white/[0.02] rounded">
                  <span className="truncate text-[var(--text-secondary)]">{item.path_or_key}</span>
                  <span className="shrink-0 font-bold text-emerald-400">{formatBytes(item.size_bytes)}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="font-ibm-mono text-xs text-[var(--text-muted)]">
                {t.applications.leftoverSize}:{" "}
                <span className="text-emerald-400 font-bold">
                  {formatBytes(leftoverModalResult.leftovers.total_size_bytes)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <WinUIButton
                  variant="subtle"
                  onClick={() => setLeftoverModalResult(null)}
                  disabled={cleaningModalLeftovers}
                >
                  {t.common.dismiss}
                </WinUIButton>
                <WinUIButton
                  variant="primary"
                  onClick={() => handleCleanModalLeftovers(leftoverModalResult.leftovers!)}
                  disabled={cleaningModalLeftovers}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  {cleaningModalLeftovers ? t.applications.cleaningLeftovers : t.applications.cleanNow}
                </WinUIButton>
              </div>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};

export default ApplicationsPage;
