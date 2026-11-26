import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import { Page, PageHeader, Card, StatCard, Badge, ProgressBar, FilterTabs, EmptyState } from "@/components/ui";
import {
  Flash20Regular,
  Delete20Regular,
  ArrowClockwise20Regular,
  FolderOpen20Regular,
  Shield20Regular,
  Shield20Filled,
  Warning20Filled,
  CheckmarkCircle20Filled,
  CheckmarkCircle20Regular,
  Gauge20Regular,
  Search20Regular,
} from "@fluentui/react-icons";

export interface StartupItem {
  id: string;
  name: string;
  command: string;
  location: string;
  enabled: boolean;
  impact: "low" | "medium" | "high";
  is_critical: boolean;
  target_path: string | null;
}

type FilterMode = "all" | "enabled" | "disabled" | "high" | "critical";

const controlClass =
  "h-8 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)] text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-50";

export const StartupPage: React.FC = () => {
  const { t } = useI18nStore();
  const [items, setItems] = useState<StartupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<StartupItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  const loadStartupItems = async () => {
    setLoading(true);
    setErrorBanner(null);
    try {
      const res = await invoke<StartupItem[]>("get_startup_items");
      setItems(res);
    } catch (e) {
      console.error("Failed to load startup items:", e);
      setErrorBanner(`Failed to load startup items: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStartupItems();
  }, []);

  const handleToggle = async (item: StartupItem) => {
    if (item.is_critical) return;
    try {
      const success = await invoke<boolean>("toggle_startup_item", {
        itemId: item.id,
        enable: !item.enabled,
      });

      if (success) {
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, enabled: !i.enabled } : i))
        );
        setActionSuccess(
          !item.enabled
            ? `Enabled startup item "${item.name}".`
            : `Disabled startup item "${item.name}". Boot speed optimized.`
        );
        setTimeout(() => setActionSuccess(null), 4000);
      } else {
        setErrorBanner(`Could not update startup item "${item.name}".`);
      }
    } catch (e) {
      console.error("Failed to toggle startup item:", e);
      const msg = String(e || "");
      if (msg.toLowerCase().includes("declined") || msg.toLowerCase().includes("canceled") || msg.toLowerCase().includes("cancelled")) {
        setErrorBanner(`Administrator permission was not granted.`);
      } else {
        setErrorBanner(`Error toggling startup item: ${msg}`);
      }
    }
  };

  const handleDelete = async () => {
    if (!itemToDelete || itemToDelete.is_critical) return;
    try {
      const success = await invoke<boolean>("delete_startup_item", {
        itemId: itemToDelete.id,
      });

      if (success) {
        setItems((prev) => prev.filter((i) => i.id !== itemToDelete.id));
        setActionSuccess(`Removed "${itemToDelete.name}" from Windows startup.`);
        setTimeout(() => setActionSuccess(null), 4000);
      } else {
        setErrorBanner(`Failed to remove "${itemToDelete.name}".`);
      }
    } catch (e) {
      console.error("Failed to delete startup item:", e);
      const msg = String(e || "");
      if (msg.toLowerCase().includes("declined") || msg.toLowerCase().includes("canceled") || msg.toLowerCase().includes("cancelled")) {
        setErrorBanner(`Administrator permission was not granted.`);
      } else {
        setErrorBanner(`Error removing item: ${msg}`);
      }
    } finally {
      setItemToDelete(null);
    }
  };

  const handleRevealInExplorer = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (e) {
      console.error("Failed to reveal item in explorer:", e);
    }
  };

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        item.name.toLowerCase().includes(q) ||
        item.command.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q);
      if (!matchesSearch) return false;

      if (filterMode === "enabled") return item.enabled;
      if (filterMode === "disabled") return !item.enabled;
      if (filterMode === "high") return item.impact === "high";
      if (filterMode === "critical") return item.is_critical;
      return true;
    });
  }, [items, searchQuery, filterMode]);

  const enabledCount = useMemo(() => items.filter((i) => i.enabled).length, [items]);
  const highImpactCount = useMemo(() => items.filter((i) => i.impact === "high" && i.enabled).length, [items]);
  const criticalCount = useMemo(() => items.filter((i) => i.is_critical).length, [items]);

  const impactBadge = (impact: StartupItem["impact"]) =>
    impact === "high" ? (
      <Badge tone="danger">{t.startup.impactHigh}</Badge>
    ) : impact === "medium" ? (
      <Badge tone="warning">{t.startup.impactMedium}</Badge>
    ) : (
      <Badge>{t.startup.impactLow}</Badge>
    );

  return (
    <Page className="select-none">
      <PageHeader
        icon={<Flash20Regular />}
        title={t.startup.title}
        description={t.startup.pageDesc}
        actions={
          <WinUIButton
            variant="standard"
            onClick={loadStartupItems}
            disabled={loading}
            icon={<ArrowClockwise20Regular className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />}
          >
            {loading ? t.common.scanning : t.common.refresh}
          </WinUIButton>
        }
      />

      {/* Notices */}
      {actionSuccess && (
        <Card className="py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <CheckmarkCircle20Filled className="w-4 h-4 shrink-0 text-[var(--success)]" />
            <span className="text-sm text-[var(--text-primary)] truncate" title={actionSuccess}>
              {actionSuccess}
            </span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setActionSuccess(null)}>
            {t.common.close}
          </WinUIButton>
        </Card>
      )}

      {errorBanner && (
        <Card className="py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Warning20Filled className="w-4 h-4 shrink-0 text-[var(--danger)]" />
            <span className="text-sm text-[var(--danger)] truncate" title={errorBanner}>
              {errorBanner}
            </span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setErrorBanner(null)}>
            {t.common.close}
          </WinUIButton>
        </Card>
      )}

      {/* Stat row */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t.startup.filterAll}
          value={items.length}
          hint={t.startup.statAllDesc}
          icon={<Flash20Regular />}
        />
        <StatCard
          label={t.common.enabled}
          value={enabledCount}
          hint={t.startup.statEnabledDesc}
          icon={<CheckmarkCircle20Regular />}
        />
        <StatCard
          label={t.startup.filterHigh}
          value={highImpactCount}
          hint={t.startup.statHighDesc}
          icon={<Gauge20Regular />}
          tone={highImpactCount > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label={t.startup.statProtected}
          value={criticalCount}
          hint={t.startup.statCriticalDesc}
          icon={<Shield20Regular />}
        />
      </div>

      {/* Filter tabs and search */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <FilterTabs<FilterMode>
          items={[
            { id: "all", label: t.startup.filterAll, count: items.length },
            { id: "enabled", label: t.common.enabled, count: enabledCount },
            { id: "disabled", label: t.common.disabled, count: items.length - enabledCount },
            { id: "high", label: t.startup.filterHigh, count: highImpactCount },
            { id: "critical", label: t.startup.filterCritical, count: criticalCount },
          ]}
          value={filterMode}
          onChange={setFilterMode}
          className="min-w-0"
        />
        <div className="relative shrink-0 lg:w-56">
          <Search20Regular className="w-4 h-4 absolute left-2.5 top-2 text-[var(--text-muted)] pointer-events-none" />
          <input
            type="text"
            placeholder={t.startup.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className={`${controlClass} w-full pl-8 pr-3 placeholder-[var(--text-muted)] select-text`}
          />
        </div>
      </div>

      {/* Startup items list */}
      {loading ? (
        <Card className="space-y-3">
          <div className="text-sm font-semibold text-[var(--text-primary)]">{t.common.scanning}</div>
          <ProgressBar value={75} className="animate-pulse" />
          <p className="text-xs text-[var(--text-muted)]">{t.startup.loadingDesc}</p>
        </Card>
      ) : filteredItems.length > 0 ? (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="text-sm font-semibold text-[var(--text-primary)] truncate select-all" title={item.name}>
                      {item.name}
                    </span>
                    {impactBadge(item.impact)}
                    {item.is_critical && (
                      <Badge tone="accent">
                        <Shield20Filled className="w-3 h-3" />
                        {t.startup.systemCritical}
                      </Badge>
                    )}
                    <Badge className="font-code">{item.location}</Badge>
                  </div>
                  <div
                    className="font-code text-xs text-[var(--text-muted)] truncate mt-1 select-all"
                    title={item.command}
                  >
                    {item.command}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {item.target_path ? (
                    <span title={t.startup.openLocation}>
                      <WinUIButton
                        variant="subtle"
                        size="sm"
                        className="w-8 !px-0"
                        aria-label={t.startup.openLocation}
                        onClick={() => handleRevealInExplorer(item.target_path!)}
                        icon={<FolderOpen20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                      />
                    </span>
                  ) : (
                    <span className="w-8" />
                  )}

                  <span
                    title={item.is_critical ? t.startup.cannotDisableCritical : undefined}
                    className="w-[92px] flex"
                  >
                    <WinUIToggle
                      checked={item.enabled}
                      disabled={item.is_critical}
                      onChange={() => handleToggle(item)}
                      labelOn={t.common.enabled}
                      labelOff={t.common.disabled}
                    />
                  </span>

                  {!item.is_critical ? (
                    <span title={t.startup.deleteItem}>
                      <WinUIButton
                        variant="subtle"
                        size="sm"
                        className="w-8 !px-0"
                        aria-label={t.startup.deleteItem}
                        onClick={() => setItemToDelete(item)}
                        icon={<Delete20Regular className="w-4 h-4 text-[var(--text-secondary)]" />}
                      />
                    </span>
                  ) : (
                    <span className="w-8" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          icon={items.length > 0 ? <Search20Regular /> : <Flash20Regular />}
          title={t.startup.noItemsFound}
          description={t.startup.noItemsDesc}
        />
      )}

      {/* Delete confirmation */}
      {itemToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Delete20Regular className="w-5 h-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t.startup.confirmDeleteTitle}</h3>
                <p className="text-sm text-[var(--text-secondary)]">{t.startup.confirmDeleteDesc}</p>
              </div>
            </div>

            <div className="rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] px-3 py-2 space-y-1">
              <div className="text-sm font-semibold text-[var(--text-primary)]">{itemToDelete.name}</div>
              <div className="font-code text-xs text-[var(--text-muted)] break-all select-text">{itemToDelete.command}</div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <WinUIButton variant="standard" onClick={() => setItemToDelete(null)}>
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton variant="danger" onClick={handleDelete} icon={<Delete20Regular className="w-4 h-4" />}>
                {t.common.delete}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default StartupPage;
