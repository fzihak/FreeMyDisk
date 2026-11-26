import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import {
  Flash24Filled,
  Flash20Regular,
  Delete20Regular,
  ArrowClockwise20Regular,
  FolderOpen20Regular,
  Shield20Filled,
  Warning20Filled,
  CheckmarkCircle20Filled,
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

export const StartupPage: React.FC = () => {
  const { t } = useI18nStore();
  const [items, setItems] = useState<StartupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [itemToDelete, setItemToDelete] = useState<StartupItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<"all" | "enabled" | "disabled" | "high" | "critical">("all");

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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-amber-400 shrink-0">
            <Flash24Filled className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.startup.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] text-xs font-ibm-mono uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20">
                {t.startup.filterCritical}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.startup.subtitle}
            </p>
          </div>
        </div>

        <WinUIButton
          variant="primary"
          onClick={loadStartupItems}
          disabled={loading}
          className="flex items-center gap-1.5 self-start sm:self-auto"
        >
          <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          <span>{loading ? t.common.scanning : t.common.refresh}</span>
        </WinUIButton>
      </div>

      {/* Notifications */}
      {actionSuccess && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs text-emerald-400 font-medium">{actionSuccess}</span>
          </div>
          <button
            onClick={() => setActionSuccess(null)}
            className="text-xs text-emerald-400 hover:text-white px-2 py-0.5 rounded-[3px] bg-emerald-500/20 font-medium cursor-pointer"
          >
            {t.common.close}
          </button>
        </div>
      )}

      {errorBanner && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-[4px] flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-2.5">
            <Warning20Filled className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="text-xs text-rose-400 font-medium">{errorBanner}</span>
          </div>
          <button
            onClick={() => setErrorBanner(null)}
            className="text-xs text-rose-400 hover:text-white px-2 py-0.5 rounded-[3px] bg-rose-500/20 font-medium cursor-pointer"
          >
            {t.common.close}
          </button>
        </div>
      )}

      {/* 4-Tile Stat Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 font-ibm-mono">
        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.startup.filterAll}</span>
            <Flash20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
          </div>
          <div className="text-xl font-bold text-[var(--text-primary)] tabular-nums">{items.length}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.startup.statAllDesc}</div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.startup.filterEnabled}</span>
            <CheckmarkCircle20Filled className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-emerald-400 tabular-nums">{enabledCount}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.startup.statEnabledDesc}</div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.startup.filterHigh}</span>
            <Flash20Regular className="w-3.5 h-3.5 text-rose-400" />
          </div>
          <div className="text-xl font-bold text-rose-400 tabular-nums">{highImpactCount}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.startup.statHighDesc}</div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.startup.criticalSystem}</span>
            <Shield20Filled className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div className="text-xl font-bold text-cyan-400 tabular-nums">{criticalCount}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">{t.startup.statCriticalDesc}</div>
        </WinUICard>
      </div>

      {/* Search & Filter Bar */}
      <WinUICard className="p-3 flex flex-col lg:flex-row items-center justify-between gap-3">
        <div className="relative w-full lg:w-72">
          <Search20Regular className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder={t.startup.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-black/20 border border-[var(--border-card)] rounded-[4px] text-xs font-ibm-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden w-full lg:w-auto font-sans">
          {(["all", "enabled", "disabled", "high", "critical"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={`px-3 py-1 rounded-[4px] text-xs font-medium whitespace-nowrap transition-all cursor-pointer ${
                filterMode === mode
                  ? "bg-amber-600 text-white shadow-xs"
                  : "bg-black/20 text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-card)]"
              }`}
            >
              {mode === "all"
                ? `${t.startup.filterAll} (${items.length})`
                : mode === "enabled"
                ? `${t.startup.filterEnabled} (${enabledCount})`
                : mode === "disabled"
                ? `${t.startup.filterDisabled} (${items.length - enabledCount})`
                : mode === "high"
                ? `${t.startup.filterHigh} (${highImpactCount})`
                : `${t.startup.filterCritical} (${criticalCount})`}
            </button>
          ))}
        </div>
      </WinUICard>

      {/* Startup Items List */}
      {loading ? (
        <WinUICard className="p-8 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
            </span>
            <span>{t.common.scanning}</span>
          </div>
          <div className="max-w-xs mx-auto h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full animate-pulse w-3/4" />
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            Querying Windows Run registry entries, Startup folders, and Task Scheduler triggers...
          </p>
        </WinUICard>
      ) : filteredItems.length > 0 ? (
        <WinUICard className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors"
              >
                <div className="space-y-0.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[var(--text-primary)] text-xs truncate select-all">
                      {item.name}
                    </span>
                    {item.is_critical && (
                      <span className="flex items-center gap-1 px-1.5 py-0.2 rounded-[3px] text-xs font-ibm-mono bg-rose-500/10 text-rose-400 border border-rose-500/20 font-bold">
                        <Shield20Filled className="w-3 h-3" /> System Critical
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.2 rounded-[3px] text-xs font-ibm-mono font-bold uppercase tracking-wider ${
                        item.impact === "high"
                          ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                          : item.impact === "medium"
                          ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                          : "bg-black/20 text-[var(--text-muted)]"
                      }`}
                    >
                      {item.impact === "high" ? t.startup.impactHigh : item.impact === "medium" ? t.startup.impactMedium : t.startup.impactLow}
                    </span>
                    <span className="text-xs px-1.5 py-0.2 rounded-[3px] bg-black/20 text-[var(--text-muted)] font-ibm-mono">
                      {item.location}
                    </span>
                  </div>

                  <div className="text-xs font-ibm-mono text-[var(--text-secondary)] truncate max-w-3xl select-all">
                    {item.command}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {/* Show in File Explorer */}
                  {item.target_path && (
                    <button
                      onClick={() => handleRevealInExplorer(item.target_path!)}
                      title={t.common.openInExplorer}
                      className="p-1.5 bg-black/20 hover:bg-[#0078d4] hover:text-white text-[var(--text-secondary)] rounded-[4px] transition-all cursor-pointer border border-[var(--border-card)]"
                    >
                      <FolderOpen20Regular className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* WinUI 3 Native Toggle Switch */}
                  <WinUIToggle
                    checked={item.enabled}
                    disabled={item.is_critical}
                    onChange={() => handleToggle(item)}
                    labelOn={t.common.enabled}
                    labelOff={t.common.disabled}
                  />

                  {/* Delete Button */}
                  {!item.is_critical && (
                    <button
                      onClick={() => setItemToDelete(item)}
                      title={t.startup.deleteItem}
                      className="p-1.5 text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 rounded-[4px] transition-all cursor-pointer"
                    >
                      <Delete20Regular className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </WinUICard>
      ) : (
        <WinUICard className="p-12 text-center space-y-2">
          <Flash24Filled className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
          <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.startup.noItemsFound}</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto">
            {t.startup.noItemsDesc}
          </p>
        </WinUICard>
      )}

      {/* Delete Confirmation Modal */}
      {itemToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
          <WinUICard className="max-w-md w-full p-5 space-y-3 shadow-2xl relative">
            <div className="flex items-center gap-2.5 text-rose-400">
              <div className="p-1.5 rounded-[4px] bg-rose-500/10 border border-rose-500/30">
                <Warning20Filled className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--text-primary)] text-sm">{t.startup.confirmDeleteTitle}</h3>
                <p className="text-xs text-[var(--text-secondary)]">
                  {t.startup.confirmDeleteDesc}
                </p>
              </div>
            </div>

            <p className="text-xs text-[var(--text-primary)] font-semibold">
              {itemToDelete.name}
            </p>

            <div className="p-2.5 bg-black/30 rounded-[4px] text-xs font-ibm-mono text-[var(--text-muted)] break-all border border-[var(--border-card)]">
              {itemToDelete.command}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <WinUIButton
                variant="subtle"
                onClick={() => setItemToDelete(null)}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleDelete}
              >
                {t.common.delete}
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};

export default StartupPage;
