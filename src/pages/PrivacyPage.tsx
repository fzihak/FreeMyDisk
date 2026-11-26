import React, { useEffect, useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { useScanProgress, useScanProgressStore } from "@/stores/scan-progress-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState, ActionBar } from "@/components/ui";
import {
  ShieldCheckmark20Regular,
  ArrowClockwise20Regular,
  Delete20Regular,
  Warning20Filled,
  CheckmarkCircle20Filled,
  LockClosed20Regular,
  Globe20Regular,
  Add20Regular,
  Dismiss20Regular,
  Search20Regular,
  Flash20Regular,
  History20Regular,
  Storage20Regular,
  Layer20Regular,
  HardDrive20Regular,
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

/** Items locked by a running browser can't be selected, except caches. */
const isSelectable = (item: PrivacyItem) => !item.is_locked || item.category === "cache";

/** Live progress of a running scan or clean, fed by the backend progress events. */
const ScanProgressCard: React.FC<{ scanType: string; title: string }> = ({ scanType, title }) => {
  const { initProgressListener } = useScanProgressStore();
  const progress = useScanProgress(scanType);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    initProgressListener().then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [initProgressListener]);

  const percent = Math.max(1, Math.min(100, progress.percent || 1));

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">{progress.stage || title}</div>
          <div className="text-xs text-[var(--text-secondary)] mt-0.5 truncate">{title}</div>
        </div>
        <span className="text-sm font-ibm-mono text-[var(--text-secondary)] shrink-0">{percent}%</span>
      </div>
      <ProgressBar value={percent} />
      <div className="flex items-center justify-between gap-4">
        <div className="font-code text-xs text-[var(--text-muted)] truncate min-w-0" title={progress.currentPath}>
          {progress.currentPath || "…"}
        </div>
        {progress.itemsScanned > 0 && (
          <span className="text-xs font-ibm-mono text-[var(--text-muted)] shrink-0">
            {progress.itemsScanned.toLocaleString()}
          </span>
        )}
      </div>
    </Card>
  );
};

/** Native checkbox that can show the "some selected" state. */
const TriCheckbox: React.FC<{
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  title?: string;
  onChange: () => void;
}> = ({ checked, indeterminate, disabled, title, onChange }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      title={title}
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      onChange={onChange}
      className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
};

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

  /** Filtered items grouped per browser, in first-seen order. */
  const browserGroups = useMemo(() => {
    const map = new Map<string, PrivacyItem[]>();
    for (const item of filteredItems) {
      const list = map.get(item.browser_name);
      if (list) list.push(item);
      else map.set(item.browser_name, [item]);
    }
    return Array.from(map.entries()).map(([name, groupItems]) => ({
      name,
      items: groupItems,
      profileCount: new Set(groupItems.map((i) => i.profile_name)).size,
      totalBytes: groupItems.reduce((acc, i) => acc + i.size_bytes, 0),
    }));
  }, [filteredItems]);

  const selectedBytes = useMemo(() => {
    return items
      .filter((i) => selectedItemIds.has(i.id))
      .reduce((acc, i) => acc + i.size_bytes, 0);
  }, [items, selectedItemIds]);

  const lockedCount = useMemo(() => items.filter((i) => i.is_locked).length, [items]);

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

  const toggleItem = (item: PrivacyItem) => {
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
  };

  /** Selects every selectable item of one browser group, or clears them if all are selected. */
  const toggleBrowserGroup = (groupItems: PrivacyItem[]) => {
    const selectable = groupItems.filter(isSelectable);
    const allSelected = selectable.length > 0 && selectable.every((i) => selectedItemIds.has(i.id));
    const next = new Set(selectedItemIds);
    for (const item of selectable) {
      if (allSelected) next.delete(item.id);
      else next.add(item.id);
    }
    setSelectedItemIds(next);
  };

  const getCategoryIcon = (category: PrivacyCategoryKind) => {
    const cls = "w-4 h-4 text-[var(--text-secondary)]";
    switch (category) {
      case "cache":
        return <Flash20Regular className={cls} />;
      case "history":
        return <History20Regular className={cls} />;
      case "cookies":
        return <Globe20Regular className={cls} />;
      case "sessions":
        return <Storage20Regular className={cls} />;
      default:
        return <ShieldCheckmark20Regular className={cls} />;
    }
  };

  const categoryTabs = [
    { id: "all", label: t.privacy.allTypes },
    { id: "cache", label: t.privacy.categoryCache },
    { id: "history", label: t.privacy.categoryHistory },
    { id: "cookies", label: t.privacy.categoryCookies },
    { id: "sessions", label: t.privacy.categorySessions },
    { id: "system_activity", label: t.privacy.categoryActivity },
  ];

  const browserTabs = [
    { id: "all", label: t.privacy.filterAll, count: browserNames.length },
    ...browserNames.map((name) => ({ id: name, label: name })),
  ];

  const busy = loading || cleaning;

  return (
    <Page className="select-none">
      <PageHeader
        icon={<ShieldCheckmark20Regular />}
        title={
          <span className="inline-flex items-center gap-3">
            {t.privacy.title}
            <Badge tone="accent">{t.privacy.dataProtectionBadge}</Badge>
          </span>
        }
        description={t.privacy.subtitle}
        actions={
          <>
            <WinUIButton
              variant="standard"
              onClick={() => setWhitelistModalOpen(true)}
              icon={<Globe20Regular className="w-4 h-4" />}
            >
              {t.privacy.cookieWhitelist}
              <span className="ml-1 text-xs font-ibm-mono text-[var(--text-muted)]">{whitelistDomains.length}</span>
            </WinUIButton>
            <WinUIButton
              variant="standard"
              onClick={handleScan}
              disabled={loading}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />}
            >
              {loading ? t.common.scanning : t.common.rescan}
            </WinUIButton>
          </>
        }
      />

      {/* Running browsers notice with 1-click close */}
      {scanResult && scanResult.running_browsers.length > 0 && (
        <Card
          className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{
            borderColor: "color-mix(in srgb, var(--brand-amber) 45%, transparent)",
            background: "color-mix(in srgb, var(--brand-amber) 8%, var(--bg-card))",
          }}
        >
          <div className="flex items-start gap-3 min-w-0">
            <Warning20Filled className="w-5 h-5 text-[var(--brand-amber)] shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--text-primary)]">{t.privacy.activeBrowserNotice}</div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                {t.privacy.runningBrowsers}: {scanResult.running_browsers.join(", ")}
              </div>
            </div>
          </div>
          <WinUIButton
            variant="standard"
            size="sm"
            onClick={handleCloseBrowsers}
            disabled={closingBrowsers}
            className="self-start sm:self-auto shrink-0"
          >
            {closingBrowsers ? t.privacy.closingBrowsers : t.privacy.closeBrowsers}
          </WinUIButton>
        </Card>
      )}

      {/* Status notification */}
      {statusMessage && (
        <Card className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CheckmarkCircle20Filled className="w-5 h-5 text-[var(--success)] shrink-0" />
            <span className="text-sm text-[var(--text-primary)]">{statusMessage}</span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setStatusMessage(null)}>
            {t.common.close}
          </WinUIButton>
        </Card>
      )}

      {busy ? (
        <ScanProgressCard scanType="privacy" title={loading ? t.common.scanning : t.privacy.cleaningProgress} />
      ) : !scanResult ? (
        <EmptyState
          icon={<ShieldCheckmark20Regular />}
          title={t.privacy.scanTitle}
          description={t.privacy.scanDesc}
          action={
            <WinUIButton variant="primary" onClick={handleScan} icon={<Search20Regular className="w-4 h-4" />}>
              {t.privacy.startScan}
            </WinUIButton>
          }
        />
      ) : (
        <>
          {/* Stats */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t.privacy.statItems}
              icon={<Layer20Regular />}
              value={items.length.toLocaleString()}
              hint={`${filteredItems.length} ${t.privacy.itemsShown}`}
            />
            <StatCard
              label={t.privacy.statSize}
              icon={<HardDrive20Regular />}
              tone="success"
              value={formatBytes(scanResult.total_size_bytes)}
              hint={`${formatBytes(selectedBytes)} ${t.privacy.selectedLabel}`}
            />
            <StatCard
              label={t.privacy.statBrowsers}
              icon={<Globe20Regular />}
              value={browserNames.length}
              hint={`${scanResult.running_browsers.length} ${t.privacy.runningLabel}`}
            />
            <StatCard
              label={t.privacy.statLocked}
              icon={<LockClosed20Regular />}
              tone={lockedCount > 0 ? "warning" : "neutral"}
              value={lockedCount}
              hint={lockedCount > 0 ? t.privacy.lockedHint : t.privacy.nothingLocked}
            />
          </div>

          {/* Filters */}
          <div className="space-y-2">
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              <FilterTabs
                className="flex-1 min-w-0"
                items={categoryTabs}
                value={activeCategoryFilter}
                onChange={setActiveCategoryFilter}
              />
              <div className="relative w-full md:w-60 shrink-0">
                <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  placeholder={t.privacy.searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full h-8 pl-8 pr-3 bg-[var(--bg-input)] border border-[var(--border-card)] rounded-md text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
            <div className="flex flex-col md:flex-row md:items-center gap-2">
              {browserNames.length > 1 ? (
                <FilterTabs
                  className="flex-1 min-w-0"
                  items={browserTabs}
                  value={activeBrowserFilter}
                  onChange={setActiveBrowserFilter}
                />
              ) : (
                <div className="flex-1" />
              )}
              <div className="flex items-center gap-2 shrink-0">
                <WinUIButton size="sm" onClick={handleSelectAll}>
                  {t.common.selectAll}
                </WinUIButton>
                <WinUIButton size="sm" variant="subtle" onClick={handleDeselectAll}>
                  {t.common.deselectAll}
                </WinUIButton>
              </div>
            </div>
          </div>

          {/* Results, one card per browser */}
          {browserGroups.length > 0 ? (
            <div className="space-y-3">
              {browserGroups.map((group) => {
                const selectable = group.items.filter(isSelectable);
                const selectedInGroup = selectable.filter((i) => selectedItemIds.has(i.id)).length;
                const allSelected = selectable.length > 0 && selectedInGroup === selectable.length;

                return (
                  <Card key={group.name} padded={false} className="overflow-hidden">
                    <div className="px-4 py-3 flex items-center gap-3 border-b border-[var(--border-divider)]">
                      <TriCheckbox
                        checked={allSelected}
                        indeterminate={selectedInGroup > 0 && !allSelected}
                        disabled={selectable.length === 0}
                        title={t.privacy.selectAllInBrowser}
                        onChange={() => toggleBrowserGroup(group.items)}
                      />
                      <Globe20Regular className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
                      <div className="min-w-0 flex-1 flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{group.name}</span>
                        <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                          {group.profileCount} {group.profileCount === 1 ? t.privacy.profile : t.privacy.profiles} ·{" "}
                          {group.items.length} {t.privacy.items}
                        </span>
                      </div>
                      <span className="text-sm font-semibold font-ibm-mono text-[var(--text-primary)] shrink-0 tabular-nums">
                        {formatBytes(group.totalBytes)}
                      </span>
                    </div>

                    <div className="divide-y divide-[var(--border-divider)]">
                      {group.items.map((item) => {
                        const isSelected = selectedItemIds.has(item.id);
                        const canSelect = isSelectable(item);
                        const showProfile =
                          !!item.profile_name && (item.profile_name !== "Default" || group.profileCount > 1);

                        return (
                          <div
                            key={item.id}
                            onClick={() => toggleItem(item)}
                            className={`px-4 py-3 flex items-center gap-3 transition-colors cursor-pointer hover:bg-[var(--fill-subtle)] ${
                              canSelect ? "" : "opacity-80"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={!canSelect}
                              aria-label={item.title}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleItem(item)}
                              className="accent-[var(--accent)] w-4 h-4 shrink-0 cursor-pointer disabled:pointer-events-none disabled:opacity-50"
                            />
                            <span className="shrink-0">{getCategoryIcon(item.category)}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm text-[var(--text-primary)] truncate">{item.title}</span>
                                {showProfile && <Badge>{item.profile_name}</Badge>}
                                {item.is_locked && (
                                  <Badge tone="warning">
                                    <LockClosed20Regular className="w-3 h-3" />
                                    {t.privacy.lockedByBrowser}
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate" title={item.description}>
                                {item.description}
                              </p>
                            </div>
                            <span className="text-sm font-ibm-mono text-[var(--text-secondary)] shrink-0 text-right tabular-nums">
                              {formatBytes(item.size_bytes)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={<ShieldCheckmark20Regular />}
              title={t.privacy.noItemsFound}
              description={t.privacy.noItemsDesc}
            />
          )}
        </>
      )}

      {/* Selection actions */}
      {scanResult && !loading && selectedItemIds.size > 0 && (
        <ActionBar
          summary={
            <>
              <span className="font-semibold text-[var(--text-primary)]">
                {selectedItemIds.size} {t.privacy.selectedLabel}
              </span>{" "}
              · <span className="font-ibm-mono">{formatBytes(selectedBytes)}</span>
            </>
          }
        >
          <WinUIButton variant="subtle" onClick={handleDeselectAll} disabled={busy}>
            {t.common.deselectAll}
          </WinUIButton>
          <WinUIButton
            variant="primary"
            onClick={handleClean}
            disabled={cleaning || loading}
            icon={<Delete20Regular className="w-4 h-4" />}
          >
            {cleaning ? t.privacy.cleaningProgress : t.privacy.cleanSelected}
          </WinUIButton>
        </ActionBar>
      )}

      {/* Cookie whitelist modal */}
      {whitelistModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center text-[var(--accent-text)] shrink-0">
                  <Globe20Regular className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.privacy.whitelistTitle}</h3>
                  <p className="text-sm text-[var(--text-secondary)] mt-0.5">{t.privacy.whitelistDesc}</p>
                </div>
              </div>
              <WinUIButton
                variant="subtle"
                size="sm"
                aria-label={t.common.close}
                onClick={() => setWhitelistModalOpen(false)}
                icon={<Dismiss20Regular className="w-4 h-4" />}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder={t.privacy.domainPlaceholder}
                value={newDomainInput}
                onChange={(e) => setNewDomainInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddDomain()}
                className="flex-1 h-8 px-3 bg-[var(--bg-input)] border border-[var(--border-card)] rounded-md text-sm font-code text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
              <WinUIButton variant="primary" onClick={handleAddDomain} icon={<Add20Regular className="w-4 h-4" />}>
                {t.privacy.addDomain}
              </WinUIButton>
            </div>

            <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border-card)] divide-y divide-[var(--border-divider)]">
              {whitelistDomains.map((dom) => (
                <div
                  key={dom}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <span className="font-code text-xs text-[var(--text-primary)] truncate">{dom}</span>
                  <button
                    onClick={() => handleRemoveDomain(dom)}
                    aria-label={dom}
                    className="text-[var(--text-muted)] hover:text-[var(--danger)] p-1 rounded-md hover:bg-[var(--fill-subtle-hover)] transition-colors cursor-pointer"
                  >
                    <Dismiss20Regular className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-3 border-t border-[var(--border-divider)]">
              <WinUIButton variant="standard" onClick={() => setWhitelistModalOpen(false)}>
                {t.common.close}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default PrivacyPage;
