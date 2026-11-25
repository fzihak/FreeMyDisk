import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { LiveScanProgressWidget } from "@/components/shared/LiveScanProgressWidget";
import {
  ShieldCheckmark24Filled,
  ShieldCheckmark20Regular,
  ArrowClockwise20Regular,
  Delete20Regular,
  Warning20Filled,
  CheckmarkCircle20Filled,
  Checkmark16Filled,
  LockClosed20Regular,
  Globe20Regular,
  Add20Regular,
  Dismiss20Regular,
  Search20Regular,
  Flash20Regular,
  History20Regular,
  Storage20Regular,
} from "@fluentui/react-icons";

export type PrivacyCategoryKind =
  | "cache"
  | "history"
  | "downloads"
  | "cookies"
  | "sessions"
  | "system_activity";

export interface PrivacyItem {
  id: string;
  browser_id: string;
  browser_name: string;
  profile_name: string;
  category: PrivacyCategoryKind;
  title: string;
  description: string;
  size_bytes: number;
  item_count: number;
  is_locked: boolean;
  paths: string[];
}

export interface PrivacyScanResult {
  items: PrivacyItem[];
  total_size_bytes: number;
  running_browsers: string[];
}

export const PrivacyPage: React.FC = () => {
  const { t } = useI18nStore();
  const [scanResult, setScanResult] = useState<PrivacyScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [closingBrowsers, setClosingBrowsers] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [activeBrowserFilter, setActiveBrowserFilter] = useState<string>("all");
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [whitelistModalOpen, setWhitelistModalOpen] = useState(false);
  const [whitelistDomains, setWhitelistDomains] = useState<string[]>(() => {
    const saved = localStorage.getItem("freemydisk_whitelist_domains");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // Fallback to defaults
      }
    }
    return [
      "google.com",
      "github.com",
      "microsoft.com",
      "apple.com",
      "youtube.com",
    ];
  });

  useEffect(() => {
    localStorage.setItem("freemydisk_whitelist_domains", JSON.stringify(whitelistDomains));
  }, [whitelistDomains]);

  const [newDomainInput, setNewDomainInput] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const handleScan = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await invoke<PrivacyScanResult>("scan_privacy_data");
      setScanResult(res);
      // Default select all non-locked items
      const initialSelected = new Set<string>();
      for (const item of res.items) {
        if (!item.is_locked || item.category === "cache") {
          initialSelected.add(item.id);
        }
      }
      setSelectedItemIds(initialSelected);
    } catch (e) {
      console.error("Failed to scan privacy data:", e);
      setStatusMessage(`Scan failed: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    handleScan();
  }, []);

  const handleClean = async () => {
    if (selectedItemIds.size === 0) return;
    setCleaning(true);
    try {
      const ids = Array.from(selectedItemIds);
      const reclaimed = await invoke<number>("clean_privacy_data", {
        itemIds: ids,
        whitelistDomains,
      });
      setStatusMessage(`Cleaned privacy data and safely freed ${formatBytes(reclaimed)}.`);
      setTimeout(() => setStatusMessage(null), 5000);
      handleScan();
    } catch (e) {
      console.error("Failed to clean privacy data:", e);
      setStatusMessage(`Cleaning failed: ${e}`);
    } finally {
      setCleaning(false);
    }
  };

  const handleCloseBrowsers = async () => {
    setClosingBrowsers(true);
    try {
      const closed = await invoke<number>("close_running_browsers");
      setStatusMessage(`Closed ${closed} active browser processes. Rescanning privacy items...`);
      setTimeout(() => setStatusMessage(null), 5000);
      setTimeout(() => {
        handleScan();
      }, 500);
    } catch (e) {
      console.error("Failed to close browsers:", e);
      setStatusMessage(`Failed to close browsers: ${e}`);
    } finally {
      setClosingBrowsers(false);
    }
  };

  const handleAddDomain = () => {
    const d = newDomainInput.trim().toLowerCase();
    if (d && !whitelistDomains.includes(d)) {
      setWhitelistDomains([...whitelistDomains, d]);
      setNewDomainInput("");
    }
  };

  const handleRemoveDomain = (domain: string) => {
    setWhitelistDomains(whitelistDomains.filter((d) => d !== domain));
  };

  const items = scanResult?.items || [];
  const browserNames = useMemo(() => Array.from(new Set(items.map((i) => i.browser_name))), [items]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchSource = activeBrowserFilter === "all" || item.browser_name === activeBrowserFilter;
      if (!matchSource) return false;

      const matchCategory = activeCategoryFilter === "all" || item.category === activeCategoryFilter;
      if (!matchCategory) return false;

      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.browser_name.toLowerCase().includes(q)
      );
    });
  }, [items, activeBrowserFilter, activeCategoryFilter, searchQuery]);

  const selectedBytes = useMemo(() => {
    return items
      .filter((i) => selectedItemIds.has(i.id))
      .reduce((acc, i) => acc + i.size_bytes, 0);
  }, [items, selectedItemIds]);

  const handleSelectAll = () => {
    const next = new Set<string>();
    for (const item of filteredItems) {
      if (!item.is_locked || item.category === "cache") {
        next.add(item.id);
      }
    }
    setSelectedItemIds(next);
  };

  const handleDeselectAll = () => {
    setSelectedItemIds(new Set());
  };

  const getCategoryIcon = (category: PrivacyCategoryKind) => {
    switch (category) {
      case "cache":
        return <Flash20Regular className="w-4 h-4 text-amber-400" />;
      case "history":
        return <History20Regular className="w-4 h-4 text-cyan-400" />;
      case "cookies":
        return <Globe20Regular className="w-4 h-4 text-emerald-400" />;
      case "sessions":
        return <Storage20Regular className="w-4 h-4 text-purple-400" />;
      case "system_activity":
        return <ShieldCheckmark20Regular className="w-4 h-4 text-rose-400" />;
      default:
        return <ShieldCheckmark20Regular className="w-4 h-4 text-purple-400" />;
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-purple-400 shrink-0">
            <ShieldCheckmark24Filled className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.privacy.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] text-[10px] font-ibm-mono uppercase tracking-wider bg-purple-500/10 text-purple-400 border border-purple-500/20">
                Data Protection
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.privacy.subtitle}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <WinUIButton
            variant="standard"
            onClick={() => setWhitelistModalOpen(true)}
            className="flex items-center gap-1.5 font-ibm-mono text-xs"
          >
            <Globe20Regular className="w-3.5 h-3.5 text-cyan-400" />
            <span className="font-sans">{t.privacy.cookieWhitelist}</span> ({whitelistDomains.length})
          </WinUIButton>

          <WinUIButton
            variant="subtle"
            onClick={handleScan}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{loading ? t.common.scanning : t.common.rescan}</span>
          </WinUIButton>

          {selectedItemIds.size > 0 && (
            <WinUIButton
              variant="primary"
              onClick={handleClean}
              disabled={cleaning || loading}
              className="flex items-center gap-1.5 font-ibm-mono text-xs bg-purple-600 hover:bg-purple-500 text-white"
            >
              <Delete20Regular className="w-3.5 h-3.5" />
              <span>{cleaning ? t.privacy.cleaningProgress : `${t.privacy.cleanSelected} (${formatBytes(selectedBytes)})`}</span>
            </WinUIButton>
          )}
        </div>
      </div>

      {/* Running Browsers Notice with 1-Click Close */}
      {scanResult && scanResult.running_browsers.length > 0 && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-[4px] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <Warning20Filled className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="text-xs text-amber-300">
              <span className="font-semibold">{t.privacy.activeBrowserNotice}:</span>{" "}
              {scanResult.running_browsers.join(", ")}
            </div>
          </div>
          <WinUIButton
            variant="standard"
            onClick={handleCloseBrowsers}
            disabled={closingBrowsers}
            className="self-start sm:self-auto text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border-amber-500/40 shrink-0"
          >
            {closingBrowsers ? "Closing Browsers..." : "Close Running Browsers"}
          </WinUIButton>
        </div>
      )}

      {/* Status Notification */}
      {statusMessage && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs text-emerald-400 font-medium">{statusMessage}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-xs text-emerald-400 hover:text-white px-2 py-0.5 rounded-[3px] bg-emerald-500/20 font-medium cursor-pointer"
          >
            {t.common.close}
          </button>
        </div>
      )}

      {/* Filter and Search Bar */}
      <WinUICard className="p-3 space-y-3">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-3">
          <div className="relative w-full lg:w-72">
            <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder={t.privacy.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Quick Selection Toolbar */}
          <div className="flex items-center gap-2 w-full lg:w-auto justify-end">
            <button
              onClick={handleSelectAll}
              className="text-xs px-2.5 py-1 rounded-[3px] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/30 font-medium transition-all cursor-pointer"
            >
              {t.common.selectAll}
            </button>
            <button
              onClick={handleDeselectAll}
              className="text-xs px-2.5 py-1 rounded-[3px] bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)] font-medium transition-all cursor-pointer"
            >
              {t.common.deselectAll}
            </button>
          </div>
        </div>

        {/* Category Pills & Browser Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 border-t border-[var(--border-divider)]">
          {/* Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {[
              { id: "all", label: "All Types" },
              { id: "cache", label: t.privacy.categoryCache },
              { id: "history", label: t.privacy.categoryHistory },
              { id: "cookies", label: t.privacy.categoryCookies },
              { id: "sessions", label: t.privacy.categorySessions },
              { id: "system_activity", label: t.privacy.categoryActivity },
            ].map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategoryFilter(cat.id)}
                className={`px-2.5 py-0.5 rounded-[4px] text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
                  activeCategoryFilter === cat.id
                    ? "bg-purple-600 text-white shadow-xs"
                    : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Browser Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            <button
              onClick={() => setActiveBrowserFilter("all")}
              className={`px-2.5 py-0.5 rounded-[4px] text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
                activeBrowserFilter === "all"
                  ? "bg-purple-600 text-white shadow-xs"
                  : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
              }`}
            >
              {t.privacy.filterAll} ({items.length})
            </button>
            {browserNames.map((name) => (
              <button
                key={name}
                onClick={() => setActiveBrowserFilter(name)}
                className={`px-2.5 py-0.5 rounded-[4px] text-xs font-medium transition-all whitespace-nowrap cursor-pointer ${
                  activeBrowserFilter === name
                    ? "bg-purple-600 text-white shadow-xs"
                    : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </WinUICard>

      {/* Items List */}
      {loading || cleaning ? (
        <LiveScanProgressWidget
          scanType="privacy"
          title={loading ? t.common.scanning : t.privacy.cleaningProgress}
          showCancel={false}
        />
      ) : filteredItems.length > 0 ? (
        <WinUICard className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {filteredItems.map((item) => {
              const isSelected = selectedItemIds.has(item.id);

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    if (item.is_locked && item.category !== "cache") {
                      setStatusMessage(`"${item.title}" is locked by an active browser. Close the browser to enable cleaning.`);
                      return;
                    }
                    const next = new Set(selectedItemIds);
                    if (next.has(item.id)) {
                      next.delete(item.id);
                    } else {
                      next.add(item.id);
                    }
                    setSelectedItemIds(next);
                  }}
                  className={`px-4 py-3 flex items-center justify-between gap-4 transition-colors cursor-pointer ${
                    isSelected ? "bg-purple-500/[0.04] hover:bg-purple-500/[0.08]" : "hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-4 h-4 rounded-[3px] border flex items-center justify-center shrink-0 transition-colors ${
                      isSelected
                        ? "bg-purple-600 border-purple-600 text-white"
                        : "border-[var(--border-subtle)] bg-black/20"
                    }`}>
                      {isSelected && <Checkmark16Filled className="w-3 h-3 text-white" />}
                    </div>

                    <div className="p-1.5 rounded-[4px] bg-white/[0.03] border border-[var(--border-card)] shrink-0">
                      {getCategoryIcon(item.category)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-[var(--text-primary)] text-xs truncate">
                          {item.title}
                        </span>
                        <span className="text-[10px] font-ibm-mono uppercase px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-secondary)]">
                          {item.browser_name}
                        </span>
                        {item.profile_name && item.profile_name !== "Default" && (
                          <span className="text-[10px] font-ibm-mono px-1.5 py-0.2 rounded-[3px] bg-black/30 text-[var(--text-muted)]">
                            {item.profile_name}
                          </span>
                        )}
                        {item.is_locked && (
                          <span className="flex items-center gap-1 text-[10px] font-ibm-mono px-1.5 py-0.2 rounded-[3px] bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <LockClosed20Regular className="w-3 h-3" /> {t.privacy.lockedNotice}
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">{item.description}</p>
                    </div>
                  </div>

                  <div className="font-ibm-mono text-xs font-semibold text-purple-400 shrink-0 text-right tabular-nums">
                    {formatBytes(item.size_bytes)}
                  </div>
                </div>
              );
            })}
          </div>
        </WinUICard>
      ) : (
        <WinUICard className="p-12 text-center space-y-2">
          <ShieldCheckmark24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.privacy.noItemsFound}</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.privacy.noItemsDesc}
          </p>
        </WinUICard>
      )}

      {/* Whitelist Modal */}
      {whitelistModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
          <WinUICard className="max-w-lg w-full p-5 space-y-3 shadow-2xl relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 text-cyan-400">
                <div className="p-1.5 rounded-[4px] bg-cyan-500/10 border border-cyan-500/30">
                  <Globe20Regular className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.privacy.whitelistTitle}</h3>
                  <p className="text-[11px] text-[var(--text-secondary)]">
                    {t.privacy.whitelistDesc}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setWhitelistModalOpen(false)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded-[4px] hover:bg-white/[0.05] cursor-pointer"
              >
                <Dismiss20Regular className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                placeholder={t.privacy.domainPlaceholder}
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddDomain()}
                className="flex-1 px-3 py-1.5 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-cyan-500"
              />
              <WinUIButton
                variant="primary"
                onClick={handleAddDomain}
                className="flex items-center gap-1 text-xs"
              >
                <Add20Regular className="w-3.5 h-3.5" />
                <span>{t.privacy.addDomain}</span>
              </WinUIButton>
            </div>

            <div className="max-h-56 overflow-y-auto space-y-1 pt-1">
              {whitelistDomains.map((dom) => (
                <div
                  key={dom}
                  className="flex items-center justify-between px-3 py-1.5 rounded-[4px] bg-black/20 border border-[var(--border-card)] text-xs font-ibm-mono text-[var(--text-primary)]"
                >
                  <span>{dom}</span>
                  <button
                    onClick={() => handleRemoveDomain(dom)}
                    className="text-[var(--text-muted)] hover:text-rose-400 p-0.5 transition-colors cursor-pointer"
                  >
                    <Dismiss20Regular className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-2">
              <WinUIButton
                variant="standard"
                onClick={() => setWhitelistModalOpen(false)}
              >
                {t.common.close}
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};

export default PrivacyPage;
